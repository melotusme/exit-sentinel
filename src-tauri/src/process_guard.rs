//! Unified child-process guard: blocks new spawns once shutdown starts and
//! terminates all in-flight tracked child processes (and child trees on Windows
//! via a Job Object, and process groups on Unix) so shutdown never triggers
//! Windows 0xc0000142 popups or hangs waiting on background commands.

use std::{
    collections::HashMap,
    ffi::OsStr,
    fmt,
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpawnError {
    ShuttingDown,
    Io(String),
}

impl fmt::Display for SpawnError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ShuttingDown => f.write_str("application is shutting down"),
            Self::Io(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for SpawnError {}

#[cfg(target_os = "windows")]
mod platform {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, DuplicateHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{GetCurrentProcess, TerminateProcess, PROCESS_TERMINATE},
        },
    };

    pub struct JobHandle(HANDLE);

    // Windows kernel handles are process-wide and safe to move across threads
    // while synchronized by the guard mutex.
    unsafe impl Send for JobHandle {}

    impl JobHandle {
        pub fn create() -> Option<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                unsafe { CloseHandle(handle) };
                return None;
            }
            Some(Self(handle))
        }

        pub fn assign(&self, child: &Child) {
            unsafe {
                let _ = AssignProcessToJobObject(self.0, child.as_raw_handle());
            }
        }

        pub fn terminate_and_close(self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
            // Drop closes the handle.
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    pub struct ActiveProcess {
        handle: HANDLE,
    }

    unsafe impl Send for ActiveProcess {}

    impl ActiveProcess {
        pub fn from_child(child: &Child) -> Self {
            let mut dup: HANDLE = std::ptr::null_mut();
            let ok = unsafe {
                let current = GetCurrentProcess();
                DuplicateHandle(
                    current,
                    child.as_raw_handle(),
                    current,
                    &mut dup,
                    PROCESS_TERMINATE,
                    0,
                    0,
                )
            };
            Self {
                handle: if ok != 0 { dup } else { std::ptr::null_mut() },
            }
        }

        pub fn terminate(&self) {
            if !self.handle.is_null() {
                unsafe {
                    let _ = TerminateProcess(self.handle, 1);
                }
            }
        }
    }

    impl Drop for ActiveProcess {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                unsafe {
                    let _ = CloseHandle(self.handle);
                }
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::process::Child;

    const SIGKILL: i32 = 9;

    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }

    pub struct ActiveProcess {
        pid: u32,
    }

    impl ActiveProcess {
        pub fn from_child(child: &Child) -> Self {
            Self { pid: child.id() }
        }

        pub fn terminate(&self) {
            if self.pid > 0 && self.pid <= i32::MAX as u32 {
                let pid = self.pid as i32;
                unsafe {
                    // Tracked children run in their own process group; kill the group first,
                    // then the direct PID as fallback.
                    let _ = kill(-pid, SIGKILL);
                    let _ = kill(pid, SIGKILL);
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", unix)))]
mod platform {
    use std::process::Child;

    pub struct ActiveProcess;

    impl ActiveProcess {
        pub fn from_child(_child: &Child) -> Self {
            Self
        }

        pub fn terminate(&self) {}
    }
}

#[derive(Default)]
struct RegistryState {
    blocked: bool,
    next_id: u64,
    active: HashMap<u64, platform::ActiveProcess>,
    #[cfg(target_os = "windows")]
    job: Option<platform::JobHandle>,
}

struct ActiveDropGuard<'a> {
    guard: &'a ProcessGuard,
    id: u64,
}

impl Drop for ActiveDropGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.guard.lock_state();
        state.active.remove(&self.id);
    }
}

pub struct ProcessGuard {
    blocked: AtomicBool,
    check_global_shutdown: bool,
    state: Mutex<RegistryState>,
}

impl ProcessGuard {
    fn new_global() -> Self {
        Self {
            blocked: AtomicBool::new(false),
            check_global_shutdown: true,
            state: Mutex::new(RegistryState::default()),
        }
    }

    #[cfg(test)]
    pub fn new_isolated() -> Self {
        Self {
            blocked: AtomicBool::new(false),
            check_global_shutdown: false,
            state: Mutex::new(RegistryState::default()),
        }
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn is_blocked(&self) -> bool {
        self.blocked.load(Ordering::Acquire)
            || (self.check_global_shutdown && crate::shutdown::is_shutting_down())
    }

    #[allow(dead_code)]
    pub fn active_count(&self) -> usize {
        self.lock_state().active.len()
    }

    pub fn output<I, S>(&self, program: &str, args: I) -> Result<Output, SpawnError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        if self.is_blocked() {
            return Err(SpawnError::ShuttingDown);
        }

        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let (child, id) = {
            let mut state = self.lock_state();
            if state.blocked || self.is_blocked() {
                return Err(SpawnError::ShuttingDown);
            }
            let child = cmd.spawn().map_err(|e| SpawnError::Io(e.to_string()))?;
            #[cfg(target_os = "windows")]
            {
                if state.job.is_none() {
                    state.job = platform::JobHandle::create();
                }
                if let Some(job) = state.job.as_ref() {
                    job.assign(&child);
                }
            }
            let active = platform::ActiveProcess::from_child(&child);
            state.next_id = state.next_id.wrapping_add(1);
            let id = state.next_id;
            state.active.insert(id, active);
            (child, id)
        };

        let drop_guard = ActiveDropGuard { guard: self, id };
        let result = child
            .wait_with_output()
            .map_err(|e| SpawnError::Io(e.to_string()));
        drop(drop_guard);

        if self.is_blocked() {
            return Err(SpawnError::ShuttingDown);
        }
        result
    }

    pub fn spawn_detached<I, S>(&self, program: &str, args: I) -> Result<(), SpawnError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        if self.is_blocked() {
            return Err(SpawnError::ShuttingDown);
        }

        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let state = self.lock_state();
        if state.blocked || self.is_blocked() {
            return Err(SpawnError::ShuttingDown);
        }
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| SpawnError::Io(e.to_string()))
    }

    pub fn begin_shutdown(&self) {
        self.blocked.store(true, Ordering::SeqCst);
        let mut state = self.lock_state();
        state.blocked = true;
        #[cfg(target_os = "windows")]
        if let Some(job) = state.job.take() {
            job.terminate_and_close();
        }
        for active in state.active.values() {
            active.terminate();
        }
    }

    pub fn resume_from_quiesce(&self) {
        if self.check_global_shutdown && crate::shutdown::is_exiting() {
            return;
        }
        let mut state = self.lock_state();
        if self.check_global_shutdown && crate::shutdown::is_exiting() {
            return;
        }
        state.blocked = false;
        self.blocked.store(false, Ordering::SeqCst);
    }
}

static GLOBAL: LazyLock<ProcessGuard> = LazyLock::new(ProcessGuard::new_global);

pub fn output<I, S>(program: &str, args: I) -> Result<Output, SpawnError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    GLOBAL.output(program, args)
}

pub fn spawn_detached<I, S>(program: &str, args: I) -> Result<(), SpawnError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    GLOBAL.spawn_detached(program, args)
}

pub fn begin_shutdown() {
    GLOBAL.begin_shutdown();
}

pub fn resume_from_quiesce() {
    GLOBAL.resume_from_quiesce();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    fn echo_cmd(text: &str) -> (&'static str, Vec<String>) {
        #[cfg(target_os = "windows")]
        {
            ("cmd.exe", vec!["/C".into(), format!("echo {text}")])
        }
        #[cfg(not(target_os = "windows"))]
        {
            ("/bin/echo", vec![text.into()])
        }
    }

    fn sleep_cmd() -> (&'static str, Vec<&'static str>) {
        #[cfg(target_os = "windows")]
        {
            ("ping.exe", vec!["-n", "30", "127.0.0.1"])
        }
        #[cfg(not(target_os = "windows"))]
        {
            ("/bin/sleep", vec!["30"])
        }
    }

    fn wait_for_active(guard: &ProcessGuard, expected: usize, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if guard.active_count() == expected {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "timed out waiting for active_count == {expected}, got {}",
            guard.active_count()
        );
    }

    #[test]
    fn blocks_spawn_when_shutting_down() {
        let guard = ProcessGuard::new_isolated();
        guard.begin_shutdown();

        let empty: [&str; 0] = [];
        assert_eq!(
            guard.output("nonexistent-binary-should-not-spawn", empty),
            Err(SpawnError::ShuttingDown)
        );
        assert_eq!(
            guard.spawn_detached("nonexistent-binary-should-not-spawn", empty),
            Err(SpawnError::ShuttingDown)
        );
        assert_eq!(guard.active_count(), 0);
    }

    #[test]
    fn resumes_spawn_after_cancel_quiesce() {
        let guard = ProcessGuard::new_isolated();
        guard.begin_shutdown();
        let (bin, args) = echo_cmd("resumed");
        assert_eq!(guard.output(bin, &args), Err(SpawnError::ShuttingDown));

        guard.resume_from_quiesce();
        let out = guard.output(bin, &args).expect("spawn should succeed after resume");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("resumed"));
        assert_eq!(guard.active_count(), 0);
    }

    #[test]
    fn tracks_and_cleans_up_finished_child() {
        let guard = ProcessGuard::new_isolated();
        assert_eq!(guard.active_count(), 0);
        let (bin, args) = echo_cmd("ok");
        let out = guard.output(bin, &args).expect("echo should succeed");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("ok"));
        assert_eq!(guard.active_count(), 0);
    }

    #[test]
    fn terminates_inflight_child_on_shutdown() {
        let guard = Arc::new(ProcessGuard::new_isolated());
        let worker_guard = Arc::clone(&guard);
        let (bin, args) = sleep_cmd();
        let handle = std::thread::spawn(move || worker_guard.output(bin, args));

        wait_for_active(&guard, 1, Duration::from_secs(5));
        let started = Instant::now();
        guard.begin_shutdown();

        let result = handle.join().expect("worker thread should not panic");
        assert_eq!(result, Err(SpawnError::ShuttingDown));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "shutdown took too long: {:?}",
            started.elapsed()
        );
        assert_eq!(guard.active_count(), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn terminates_child_tree_on_windows() {
        let guard = Arc::new(ProcessGuard::new_isolated());
        let worker_guard = Arc::clone(&guard);
        let handle = std::thread::spawn(move || {
            worker_guard.output("cmd.exe", ["/C", "ping.exe -n 30 127.0.0.1 >nul"])
        });

        wait_for_active(&guard, 1, Duration::from_secs(5));
        // Give cmd.exe a moment to spawn its grandchild ping.exe before terminating the job.
        std::thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        guard.begin_shutdown();

        let result = handle.join().expect("worker thread should not panic");
        assert_eq!(result, Err(SpawnError::ShuttingDown));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "child tree shutdown took too long: {:?}",
            started.elapsed()
        );
        assert_eq!(guard.active_count(), 0);
    }
}
