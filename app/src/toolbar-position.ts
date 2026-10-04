/**
 * Where the formatting toolbar floats: pinned to the top of the editor or to
 * the bottom. Shared by every window through local storage, like the theme.
 */

export const TOOLBAR_POSITION_STORAGE_KEY = "thought.toolbar-position.v1";

export type ToolbarPosition = "top" | "bottom";

export function isToolbarPosition(value: unknown): value is ToolbarPosition {
  return value === "top" || value === "bottom";
}

export function readToolbarPosition(storage: Storage | null): ToolbarPosition {
  try {
    const value = storage?.getItem(TOOLBAR_POSITION_STORAGE_KEY);
    return isToolbarPosition(value) ? value : "top";
  } catch {
    return "top";
  }
}

export function writeToolbarPosition(
  storage: Storage | null,
  position: ToolbarPosition,
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(TOOLBAR_POSITION_STORAGE_KEY, position);
    return true;
  } catch {
    return false;
  }
}

/** Top is the stylesheet default, so only Bottom needs a marker. */
export function applyToolbarPosition(root: HTMLElement, position: ToolbarPosition): void {
  if (position === "bottom") root.dataset.toolbar = "bottom";
  else delete root.dataset.toolbar;
}

/** Apply the saved position now and whenever Settings changes it. */
export function installToolbarPosition(storage: Storage | null): () => void {
  const root = document.documentElement;
  applyToolbarPosition(root, readToolbarPosition(storage));
  const onStorage = (event: StorageEvent) => {
    if (event.key === TOOLBAR_POSITION_STORAGE_KEY || event.key === null) {
      applyToolbarPosition(root, readToolbarPosition(storage));
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
