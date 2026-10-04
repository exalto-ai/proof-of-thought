import { getCurrentWindow } from "@tauri-apps/api/window";

/** True inside the native app; false in a plain browser during development. */
export function isTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

/** This page's native window, or null when there is none to address. */
export function nativeWindow() {
  return isTauri() ? getCurrentWindow() : null;
}
