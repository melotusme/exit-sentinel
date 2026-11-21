//! Process-wide shutdown coordination and Windows session-end plumbing.
//!
//! On Windows, `tao` does not intercept `WM_QUERYENDSESSION` and only exits on `WM_ENDSESSION`.
//! Without an early hook, background loops keep spawning short-lived system commands during the
//! window between `WM_QUERYENDSESSION` and `WM_ENDSESSION`, which triggers `STATUS_DLL_INIT_FAILED`
//! (`0xc0000142`) application popups and stalls OS shutdown.
//!
//! This module installs a hidden top-level Win32 window (never `HWND_MESSAGE`, which does not
//! receive broadcast session messages) plus a secondary `SetConsoleCtrlHandler` fallback, and
//! exposes a lock-free `Phase` state + `tokio::sync::watch` signal for background tasks and the
//! child-process guard.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    Running = 0,
    Quiescing = 1,
    Exiting = 2,
}

impl Phase {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Quiescing,
            2 => Self::Exiting,
            _ => Self::Running,
        }
    }
}

pub struct ShutdownController {
    phase: AtomicU8,
    transition: Mutex<()>,
    tx: watch::Sender<Phase>,
    on_quiesce: Box<dyn Fn() + Send + Sync>,
    on_resume: Box<dyn Fn() + Send + Sync>,
    on_exit: Box<dyn Fn() + Send + Sync>,
}

impl ShutdownController {
    pub fn new(
        on_quiesce: impl Fn() + Send + Sync + 'static,
        on_resume: impl Fn() + Send + Sync + 'static,
        on_exit: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let (tx, _rx) = watch::channel(Phase::Running);
        Self {
            phase: AtomicU8::new(Phase::Running as u8),
            transition: Mutex::new(()),
            tx,
            on_quiesce: Box::new(on_quiesce),
            on_resume: Box::new(on_resume),
            on_exit: Box::new(on_exit),
        }
    }

    pub fn phase(&self) -> Phase {
        Phase::from_u8(self.phase.load(Ordering::Acquire))
    }

    pub fn is_shutting_down(&self) -> bool {
        self.phase() != Phase::Running
    }

    pub fn is_exiting(&self) -> bool {
        self.phase() == Phase::Exiting
    }

    pub fn subscribe(&self) -> watch::Receiver<Phase> {
        self.tx.subscribe()
    }

    pub async fn wait_for_shutdown(&self) {
        if self.is_shutting_down() {
            return;
        }
        let mut rx = self.subscribe();
        let _ = rx.wait_for(|&p| p != Phase::Running).await;
    }

    /// While `Quiescing`, waits until either shutdown is cancelled (`Running` -> `true`)
    /// or the process enters permanent `Exiting` (`false`). Returns immediately if already
    /// `Running` or `Exiting`.
    pub async fn wait_until_active_or_exit(&self) -> bool {
        match self.phase() {
            Phase::Running => return true,
            Phase::Exiting => return false,
            Phase::Quiescing => {}
        }
        let mut rx = self.subscribe();
        let active = match rx.wait_for(|&p| p != Phase::Quiescing).await {
            Ok(p) => *p == Phase::Running,
            Err(_) => false,
        };
        active
    }

    pub fn begin_quiesce(&self) {
        let _guard = self.transition.lock().unwrap_or_else(|e| e.into_inner());
        if self.phase() != Phase::Running {
            return;
        }
        self.phase.store(Phase::Quiescing as u8, Ordering::Release);
        self.tx.send_replace(Phase::Quiescing);
        (self.on_quiesce)();
    }

    pub fn cancel_quiesce(&self) {
        let _guard = self.transition.lock().unwrap_or_else(|e| e.into_inner());
        if self.phase() != Phase::Quiescing {
            return;
        }
        self.phase.store(Phase::Running as u8, Ordering::Release);
        (self.on_resume)();
        self.tx.send_replace(Phase::Running);
    }

    pub fn begin_exit(&self) {
        let _guard = self.transition.lock().unwrap_or_else(|e| e.into_inner());
        if self.phase() == Phase::Exiting {
            return;
        }
        self.phase.store(Phase::Exiting as u8, Ordering::Release);
        self.tx.send_replace(Phase::Exiting);
        (self.on_exit)();
    }
}

static GLOBAL: OnceLock<ShutdownController> = OnceLock::new();

fn global() -> &'static ShutdownController {
    GLOBAL.get_or_init(|| {
        ShutdownController::new(
            crate::process_guard::begin_shutdown,
            crate::process_guard::resume_from_quiesce,
            crate::process_guard::begin_shutdown,
        )
    })
}

pub fn is_shutting_down() -> bool {
    global().is_shutting_down()
}

pub fn is_exiting() -> bool {
    global().is_exiting()
}

#[allow(dead_code)]
pub fn phase() -> Phase {
    global().phase()
}

#[allow(dead_code)]
pub fn subscribe() -> watch::Receiver<Phase> {
    global().subscribe()
}

pub async fn wait_for_shutdown() {
    global().wait_for_shutdown().await;
}

pub async fn wait_until_active_or_exit() -> bool {
    global().wait_until_active_or_exit().await
}

#[allow(dead_code)]
pub fn begin_quiesce() {
    global().begin_quiesce();
}

#[allow(dead_code)]
pub fn cancel_quiesce() {
    global().cancel_quiesce();
}

pub fn begin_exit() {
    global().begin_exit();
}

#[cfg(target_os = "windows")]
mod windows_hook {
    use super::{begin_exit, begin_quiesce, cancel_quiesce};
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT,
        CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassExW, WM_ENDSESSION, WM_QUERYENDSESSION,
        WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_OVERLAPPED,
    };

    static INSTALLED: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn shutdown_wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_QUERYENDSESSION => {
                begin_quiesce();
                1
            }
            WM_ENDSESSION => {
                if wparam != 0 {
                    begin_exit();
                } else {
                    cancel_quiesce();
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    unsafe extern "system" fn console_ctrl_handler(ctrl_type: u32) -> BOOL {
        match ctrl_type {
            CTRL_SHUTDOWN_EVENT
            | CTRL_LOGOFF_EVENT
            | CTRL_CLOSE_EVENT
            | CTRL_C_EVENT
            | CTRL_BREAK_EVENT => {
                begin_exit();
                0
            }
            _ => 0,
        }
    }

    /// Must be called once on the main UI thread (which runs the Win32 message loop).
    pub fn install() {
        if INSTALLED.swap(true, Ordering::AcqRel) {
            return;
        }
        // Ensure the global controller is initialized before any Win32 callback can fire.
        let _ = super::global();

        let class_name: Vec<u16> = "ExitSentinelShutdownWindow\0".encode_utf16().collect();
        unsafe {
            let hinstance = GetModuleHandleW(ptr::null());
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(shutdown_wnd_proc),
                hInstance: hinstance,
                lpszClassName: class_name.as_ptr(),
                ..Default::default()
            };
            RegisterClassExW(&wc);

            // Real hidden top-level window (hwndParent = NULL, never HWND_MESSAGE) so Windows
            // delivers WM_QUERYENDSESSION and WM_ENDSESSION broadcast messages to this thread.
            let _hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class_name.as_ptr(),
                ptr::null(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                ptr::null_mut(),
                ptr::null_mut(),
                hinstance,
                ptr::null(),
            );

            // Secondary fallback for debug/console-attached runs (GUI release builds have no console).
            let _ = SetConsoleCtrlHandler(Some(console_ctrl_handler), 1);
        }
    }
}

/// Install OS-specific shutdown listeners. Call once on the main UI thread during app setup.
pub fn install() {
    #[cfg(target_os = "windows")]
    windows_hook::install();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    struct Counters {
        quiesce: Arc<AtomicUsize>,
        resume: Arc<AtomicUsize>,
        exit: Arc<AtomicUsize>,
    }

    fn make_controller() -> (ShutdownController, Counters) {
        let quiesce = Arc::new(AtomicUsize::new(0));
        let resume = Arc::new(AtomicUsize::new(0));
        let exit = Arc::new(AtomicUsize::new(0));
        let (q, r, e) = (quiesce.clone(), resume.clone(), exit.clone());
        let controller = ShutdownController::new(
            move || {
                q.fetch_add(1, Ordering::SeqCst);
            },
            move || {
                r.fetch_add(1, Ordering::SeqCst);
            },
            move || {
                e.fetch_add(1, Ordering::SeqCst);
            },
        );
        (
            controller,
            Counters {
                quiesce,
                resume,
                exit,
            },
        )
    }

    #[test]
    fn initial_state_is_running() {
        let (c, counts) = make_controller();
        assert_eq!(c.phase(), Phase::Running);
        assert!(!c.is_shutting_down());
        assert!(!c.is_exiting());
        assert_eq!(counts.quiesce.load(Ordering::SeqCst), 0);
        assert_eq!(counts.resume.load(Ordering::SeqCst), 0);
        assert_eq!(counts.exit.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn quiesce_and_cancel_roundtrip_restores_running() {
        let (c, counts) = make_controller();
        c.begin_quiesce();
        assert_eq!(c.phase(), Phase::Quiescing);
        assert!(c.is_shutting_down());
        assert!(!c.is_exiting());
        assert_eq!(counts.quiesce.load(Ordering::SeqCst), 1);

        c.cancel_quiesce();
        assert_eq!(c.phase(), Phase::Running);
        assert!(!c.is_shutting_down());
        assert!(!c.is_exiting());
        assert_eq!(counts.resume.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn quiesce_then_exit_is_irreversible() {
        let (c, counts) = make_controller();
        c.begin_quiesce();
        c.begin_exit();
        assert_eq!(c.phase(), Phase::Exiting);
        assert!(c.is_shutting_down());
        assert!(c.is_exiting());
        assert_eq!(counts.quiesce.load(Ordering::SeqCst), 1);
        assert_eq!(counts.exit.load(Ordering::SeqCst), 1);

        // Exiting cannot be cancelled or downgraded.
        c.cancel_quiesce();
        c.begin_quiesce();
        assert_eq!(c.phase(), Phase::Exiting);
        assert!(c.is_shutting_down());
        assert!(c.is_exiting());
        assert_eq!(counts.resume.load(Ordering::SeqCst), 0);
        assert_eq!(counts.quiesce.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn transitions_are_idempotent() {
        let (c, counts) = make_controller();
        c.cancel_quiesce();
        assert_eq!(counts.resume.load(Ordering::SeqCst), 0);

        c.begin_quiesce();
        c.begin_quiesce();
        assert_eq!(counts.quiesce.load(Ordering::SeqCst), 1);

        c.cancel_quiesce();
        c.cancel_quiesce();
        assert_eq!(counts.resume.load(Ordering::SeqCst), 1);

        c.begin_exit();
        c.begin_exit();
        assert_eq!(counts.exit.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn async_waiters_react_to_quiesce_resume_and_exit() {
        let (c, _) = make_controller();
        let c = Arc::new(c);

        // Immediate when Running.
        assert!(c.wait_until_active_or_exit().await);

        // wait_for_shutdown resolves on begin_quiesce.
        let c1 = c.clone();
        let waiter = tokio::spawn(async move { c1.wait_for_shutdown().await });
        tokio::task::yield_now().await;
        c.begin_quiesce();
        waiter.await.unwrap();

        // wait_until_active_or_exit resolves to true when quiesce is cancelled.
        let c2 = c.clone();
        let resume_waiter = tokio::spawn(async move { c2.wait_until_active_or_exit().await });
        tokio::task::yield_now().await;
        c.cancel_quiesce();
        assert!(resume_waiter.await.unwrap());

        // wait_until_active_or_exit resolves to false when exiting from quiesce.
        c.begin_quiesce();
        let c3 = c.clone();
        let exit_waiter = tokio::spawn(async move { c3.wait_until_active_or_exit().await });
        tokio::task::yield_now().await;
        c.begin_exit();
        assert!(!exit_waiter.await.unwrap());

        // Immediate when Exiting.
        assert!(!c.wait_until_active_or_exit().await);
        c.wait_for_shutdown().await;
    }
}
