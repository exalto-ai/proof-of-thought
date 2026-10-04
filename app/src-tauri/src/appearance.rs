//! One appearance for the app and every window.
//!
//! Tauri's window `setTheme` sets the app-wide appearance, and each window
//! called it in turn after a theme change; a window that did not redraw kept
//! its old title bar until relaunch. This sets the app and every open window
//! explicitly, from one place, so they always switch together.

/// `None` follows the system (Auto); otherwise Light or Dark.
#[tauri::command]
pub fn apply_theme(app: tauri::AppHandle, theme: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager as _;
        let dark = match theme.as_deref() {
            None => None,
            Some("light") => Some(false),
            Some("dark") => Some(true),
            Some(_) => return Err("Unknown theme.".into()),
        };
        let windows: Vec<usize> = app
            .webview_windows()
            .values()
            .filter_map(|window| window.ns_window().ok().map(|pointer| pointer as usize))
            .collect();
        app.run_on_main_thread(move || apply(dark, &windows))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, theme);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn apply(dark: Option<bool>, windows: &[usize]) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAppearance, NSAppearanceCustomization as _, NSAppearanceNameAqua,
        NSAppearanceNameDarkAqua, NSApplication, NSWindow,
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // SAFETY: AppKit's appearance-name constants are immutable statics.
    let appearance = dark.and_then(|dark| unsafe {
        NSAppearance::appearanceNamed(if dark {
            NSAppearanceNameDarkAqua
        } else {
            NSAppearanceNameAqua
        })
    });
    NSApplication::sharedApplication(mtm).setAppearance(appearance.as_deref());
    for &address in windows {
        // SAFETY: each address is a live NSWindow Tauri handed out moments
        // ago, used on the main thread as AppKit requires.
        let window = unsafe { &*(address as *const NSWindow) };
        window.setAppearance(appearance.as_deref());
    }
}
