/**
 * Where the attribution rails sit: the left margin, the right margin, or
 * nowhere. Shared by every window through local storage, like the toolbar.
 */

import { readItem, writeItem } from "./storage";

export const RAIL_POSITION_STORAGE_KEY = "thought.rail-position.v1";

export type RailPosition = "left" | "right" | "off";

export function isRailPosition(value: unknown): value is RailPosition {
  return value === "left" || value === "right" || value === "off";
}

export function readRailPosition(storage: Storage | null): RailPosition {
  const value = readItem(storage, RAIL_POSITION_STORAGE_KEY);
  return isRailPosition(value) ? value : "left";
}

export function writeRailPosition(storage: Storage | null, position: RailPosition): boolean {
  return writeItem(storage, RAIL_POSITION_STORAGE_KEY, position);
}

/** Left is the stylesheet's layout, so only Right and Off need a marker. */
export function applyRailPosition(root: HTMLElement, position: RailPosition): void {
  if (position === "left") delete root.dataset.rails;
  else root.dataset.rails = position;
}

/** Apply the saved position now and whenever Settings changes it. */
export function installRailPosition(storage: Storage | null): () => void {
  const root = document.documentElement;
  applyRailPosition(root, readRailPosition(storage));
  const onStorage = (event: StorageEvent) => {
    if (event.key === RAIL_POSITION_STORAGE_KEY || event.key === null) {
      applyRailPosition(root, readRailPosition(storage));
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
