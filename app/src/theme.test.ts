import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, installTheme, readTheme, writeTheme } from "./theme";

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
  delete document.documentElement.dataset.theme;
});

describe("theme preference", () => {
  it("defaults to Auto for missing, unknown, or unavailable storage", () => {
    expect(readTheme(null)).toBe("auto");
    expect(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("auto");
    expect(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
    expect(writeTheme(null, "dark")).toBe(false);
  });

  it("pins Light and Dark and leaves Auto to the system", () => {
    const setTheme = vi.fn().mockResolvedValue(undefined);
    const root = document.documentElement;

    applyTheme(root, "light", { setTheme });
    expect(root.dataset.theme).toBe("light");
    expect(setTheme).toHaveBeenLastCalledWith("light");

    applyTheme(root, "auto", { setTheme });
    expect(root.dataset.theme).toBeUndefined();
    expect(setTheme).toHaveBeenLastCalledWith(null);
  });

  it("follows a change made in another window", () => {
    const storage = memoryStorage();
    const dispose = installTheme(storage);
    expect(document.documentElement.dataset.theme).toBeUndefined();

    writeTheme(storage, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    dispose();
  });
});
