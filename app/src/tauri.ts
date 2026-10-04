import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** True inside the native app; false in a plain browser during development. */
export function isTauri(): boolean {
  return Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );
}

/**
 * Sets the appearance natively on the app and every open window at once, so
 * title bars never disagree after a theme change (see appearance.rs).
 */
export function nativeAppearance(): { setTheme(theme: "light" | "dark" | null): Promise<void> } | null {
  return isTauri() ? { setTheme: (theme) => invoke<void>("apply_theme", { theme }) } : null;
}

/** This page's native window, or null when there is none to address. */
export function nativeWindow() {
  return isTauri() ? getCurrentWindow() : null;
}
