//! macOS: a right click anywhere on the open tray menu acknowledges the pending changes.
//!
//! An open NSMenu runs its own tracking loop, so the tray icon never sees the click. While the
//! tray menu is tracking, a short timer polls the right mouse button and closes the menu before
//! the button comes back up. If the right click is only seen as the menu closes, macOS may still
//! activate the item under the pointer; `swallow_item_event` drops that one event so a right
//! click never runs "退出" or any other item by accident.
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSEvent, NSEventType, NSMenu, NSMenuDidBeginTrackingNotification, NSMenuDidEndTrackingNotification};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSRunLoop, NSRunLoopCommonModes, NSTimer};
use std::cell::RefCell;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Poll often enough to catch a quick click (typically 60–120 ms between down and up).
const POLL_SECONDS: f64 = 0.008;
/// A menu item event this soon after a right-click close came from that click.
const SWALLOW_MS: u64 = 800;
const RIGHT_BUTTON: usize = 1 << 1;

static ON_RIGHT_CLICK: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
static RIGHT_CLOSED_AT: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static TRACKING: RefCell<Option<(Retained<NSMenu>, Retained<NSTimer>)>> = const { RefCell::new(None) };
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

/// Only the tray's own root menu: built by muda and not a submenu. The window's WebKit
/// context menu and the (hidden) app menu are left alone.
fn is_tray_root(menu: &NSMenu, mtm: MainThreadMarker) -> bool {
    if unsafe { menu.supermenu() }.is_some() {
        return false;
    }
    if NSApplication::sharedApplication(mtm).mainMenu().is_some_and(|m| &*m == menu) {
        return false;
    }
    menu.delegate().is_some_and(|d| {
        let obj: &AnyObject = (*d).as_ref();
        obj.class().name().to_bytes() == b"MudaMenuDelegate"
    })
}

fn right_button_involved(mtm: MainThreadMarker) -> bool {
    if NSEvent::pressedMouseButtons() & RIGHT_BUTTON != 0 {
        return true;
    }
    NSApplication::sharedApplication(mtm)
        .currentEvent()
        .is_some_and(|e| matches!(e.r#type(), NSEventType::RightMouseDown | NSEventType::RightMouseUp))
}

fn notification_menu(n: NonNull<NSNotification>) -> Option<Retained<NSMenu>> {
    unsafe { n.as_ref() }.object()?.downcast::<NSMenu>().ok()
}

fn begin(n: NonNull<NSNotification>) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(menu) = notification_menu(n) else { return };
    if !is_tray_root(&menu, mtm) {
        return;
    }
    RIGHT_CLOSED_AT.store(0, Ordering::Relaxed);
    let tick = RcBlock::new(|_timer: NonNull<NSTimer>| {
        if NSEvent::pressedMouseButtons() & RIGHT_BUTTON == 0 {
            return;
        }
        TRACKING.with(|t| {
            if let Some((menu, timer)) = t.borrow().as_ref() {
                timer.invalidate();
                RIGHT_CLOSED_AT.store(now_ms(), Ordering::Relaxed);
                menu.cancelTracking();
            }
        });
    });
    let timer = unsafe { NSTimer::timerWithTimeInterval_repeats_block(POLL_SECONDS, true, &tick) };
    // Common modes include the menu's event-tracking mode; the default mode does not run while open.
    unsafe { NSRunLoop::mainRunLoop().addTimer_forMode(&timer, NSRunLoopCommonModes) };
    TRACKING.with(|t| {
        if let Some((_, old)) = t.replace(Some((menu, timer))) {
            old.invalidate();
        }
    });
}

fn end(n: NonNull<NSNotification>) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let Some(menu) = notification_menu(n) else { return };
    let ours = TRACKING.with(|t| {
        let mut t = t.borrow_mut();
        if t.as_ref().is_some_and(|(m, _)| *m == menu) {
            if let Some((_, timer)) = t.take() {
                timer.invalidate();
            }
            true
        } else {
            false
        }
    });
    if !ours {
        return;
    }
    if RIGHT_CLOSED_AT.load(Ordering::Relaxed) == 0 && right_button_involved(mtm) {
        RIGHT_CLOSED_AT.store(now_ms(), Ordering::Relaxed);
    }
    if RIGHT_CLOSED_AT.load(Ordering::Relaxed) != 0 {
        if let Some(f) = ON_RIGHT_CLICK.get() {
            f();
        }
    }
}

/// True when a menu item event was really the right click that closed the menu.
pub fn swallow_item_event() -> bool {
    let at = RIGHT_CLOSED_AT.load(Ordering::Relaxed);
    at != 0 && now_ms().saturating_sub(at) < SWALLOW_MS
}

/// Call once on the main thread. `on_right_click` runs on the main thread as the menu closes.
pub fn install(on_right_click: impl Fn() + Send + Sync + 'static) {
    if ON_RIGHT_CLICK.set(Box::new(on_right_click)).is_err() {
        return;
    }
    let center = NSNotificationCenter::defaultCenter();
    let begin_block = RcBlock::new(begin);
    let end_block = RcBlock::new(end);
    unsafe {
        let a = center.addObserverForName_object_queue_usingBlock(Some(NSMenuDidBeginTrackingNotification), None, None, &begin_block);
        let b = center.addObserverForName_object_queue_usingBlock(Some(NSMenuDidEndTrackingNotification), None, None, &end_block);
        // Observers live for the whole process.
        std::mem::forget((a, b));
    }
}
