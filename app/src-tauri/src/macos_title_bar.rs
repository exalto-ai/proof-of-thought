//! Window buttons placed on the page's own title-bar row.
//!
//! Document windows use an overlay title bar, and the page draws a 39px
//! title-bar strip with the sidebar toggles in it. Tauri's
//! `trafficLightPosition` only moved the window buttons onto that row after a
//! resize: wry re-applies it when its parent view redraws, which the
//! full-window webview never prompts, and AppKit resets the buttons whenever
//! it lays the title bar out again. (An NSToolbar would centre them natively,
//! but its title bar then swallows clicks on the toggles.) So the app places
//! the buttons itself, again on every event after which AppKit may have moved
//! them.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

/// Left edge of the close button, in points.
const BUTTONS_X: f64 = 16.0;
/// Offset that centres the 14pt buttons on the 39pt row (centre = y - 2.5,
/// measured on the running app), matching `--chrome-height` in styles.css.
const BUTTONS_Y: f64 = 22.0;

/// Re-place a window's buttons on the main thread. Safe to call from any
/// thread and as often as needed.
pub fn place_window_buttons<R: tauri::Runtime>(window: &tauri::Window<R>) {
    if let Ok(pointer) = window.ns_window() {
        let _ = window.run_on_main_thread(task(pointer as usize));
    }
}

/// As [`place_window_buttons`], for a window built with its webview.
pub fn place_webview_window_buttons<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Ok(pointer) = window.ns_window() {
        let _ = window.run_on_main_thread(task(pointer as usize));
    }
}

/// The raw NSWindow pointer is not Send, so it crosses as an address; the
/// main thread owns the window anyway.
fn task(address: usize) -> impl FnOnce() + Send + 'static {
    move || {
        if MainThreadMarker::new().is_none() {
            return;
        }
        // SAFETY: Tauri hands out the window's own live NSWindow, and this
        // runs on the main thread, which AppKit requires.
        let window = unsafe { &*(address as *const NSWindow) };
        place(window);
    }
}

/// The same geometry wry applies for `trafficLightPosition`.
fn place(window: &NSWindow) {
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|kind| window.standardWindowButton(kind));
    let [Some(close), Some(miniaturize), zoom] = buttons else {
        return;
    };
    // SAFETY: reading a live button's view hierarchy on the main thread.
    let Some(container) = (unsafe { close.superview().and_then(|view| view.superview()) }) else {
        return;
    };
    let close_frame = NSView::frame(&close);
    let height = close_frame.size.height + BUTTONS_Y;
    let mut frame = NSView::frame(&container);
    frame.size.height = height;
    frame.origin.y = window.frame().size.height - height;
    container.setFrame(frame);

    let spacing = NSView::frame(&miniaturize).origin.x - close_frame.origin.x;
    for (index, button) in [Some(close), Some(miniaturize), zoom]
        .into_iter()
        .flatten()
        .enumerate()
    {
        let mut origin = NSView::frame(&button).origin;
        origin.x = BUTTONS_X + index as f64 * spacing;
        button.setFrameOrigin(origin);
    }
}
