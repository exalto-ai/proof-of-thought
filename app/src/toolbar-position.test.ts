import { afterEach, describe, expect, it } from "vitest";
import {
  TOOLBAR_POSITION_STORAGE_KEY,
  installToolbarPosition,
  readToolbarPosition,
  writeToolbarPosition,
} from "./toolbar-position";
import { memoryStorage } from "./test-storage";

afterEach(() => {
  delete document.documentElement.dataset.toolbar;
});

describe("toolbar position", () => {
  it("defaults to the bottom for missing, unknown, or unavailable storage", () => {
    expect(readToolbarPosition(null)).toBe("bottom");
    expect(
      readToolbarPosition(memoryStorage({ [TOOLBAR_POSITION_STORAGE_KEY]: "left" })),
    ).toBe("bottom");
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
