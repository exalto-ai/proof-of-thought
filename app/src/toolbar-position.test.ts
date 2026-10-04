import { afterEach, describe, expect, it } from "vitest";
import {
  TOOLBAR_POSITION_STORAGE_KEY,
  installToolbarPosition,
  readToolbarPosition,
  writeToolbarPosition,
} from "./toolbar-position";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

afterEach(() => {
  delete document.documentElement.dataset.toolbar;
});

describe("toolbar position", () => {
  it("defaults to the top for missing, unknown, or unavailable storage", () => {
    expect(readToolbarPosition(null)).toBe("top");
    expect(
      readToolbarPosition(memoryStorage({ [TOOLBAR_POSITION_STORAGE_KEY]: "left" })),
    ).toBe("top");
    expect(writeToolbarPosition(null, "bottom")).toBe(false);
  });

  it("marks only the bottom placement and follows changes from Settings", () => {
    const storage = memoryStorage({ [TOOLBAR_POSITION_STORAGE_KEY]: "bottom" });
    const dispose = installToolbarPosition(storage);
    expect(document.documentElement.dataset.toolbar).toBe("bottom");

    writeToolbarPosition(storage, "top");
    window.dispatchEvent(new StorageEvent("storage", { key: TOOLBAR_POSITION_STORAGE_KEY }));
    expect(document.documentElement.dataset.toolbar).toBeUndefined();
    dispose();
  });
});
