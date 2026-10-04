import { getCurrentWindow } from "@tauri-apps/api/window";

/** True inside the native app; false in a plain browser during development. */
export function isTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

/**
 * Whether this window draws the native macOS sidebar material behind a
 * transparent page. Document windows do (see tauri.conf.json); the page then
 * leaves its sidebars and title strip clear to show it.
 */
export function hasNativeSidebarMaterial(): boolean {
  return isTauri() && /Mac/.test(navigator.userAgent);
}

/** This page's native window, or null when there is none to address. */
export function nativeWindow() {
  return isTauri() ? getCurrentWindow() : null;
}
