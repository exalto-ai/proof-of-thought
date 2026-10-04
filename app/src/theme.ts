/**
 * Appearance preference shared by every window.
 *
 * Auto follows the system; Light and Dark pin one palette. Windows share an
 * origin, so a change in Settings reaches open document windows through the
 * `storage` event without any native round trip.
 */

export const THEME_STORAGE_KEY = "thought.theme.v1";

export type ThemePreference = "auto" | "light" | "dark";

type NativeWindow = {
  setTheme(theme: "light" | "dark" | null): Promise<void>;
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "auto" || value === "light" || value === "dark";
}

export function readTheme(storage: Storage | null): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeTheme(storage: Storage | null, theme: ThemePreference): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pin `data-theme` for Light and Dark; leave it unset for Auto so the
 * stylesheet's `prefers-color-scheme` rule decides. The native window follows
 * too, which keeps the traffic lights and vibrancy matched to the page.
 */
export function applyTheme(
  root: HTMLElement,
  theme: ThemePreference,
  nativeWindow: NativeWindow | null = null,
): void {
  if (theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = theme;
  void nativeWindow?.setTheme(theme === "auto" ? null : theme).catch(() => {
    // The page already reflects the choice; window chrome is best effort.
  });
}

/** Apply the saved theme now and whenever another window changes it. */
export function installTheme(
  storage: Storage | null,
  nativeWindow: NativeWindow | null = null,
): () => void {
  const root = document.documentElement;
  applyTheme(root, readTheme(storage), nativeWindow);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      applyTheme(root, readTheme(storage), nativeWindow);
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
