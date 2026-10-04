import { afterEach, describe, expect, it } from "vitest";
import {
  RAIL_POSITION_STORAGE_KEY,
  applyRailPosition,
  installRailPosition,
  readRailPosition,
  writeRailPosition,
} from "./rail-position";

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.rails;
});

describe("attribution rail position", () => {
  it("defaults to the left and ignores unknown values", () => {
    expect(readRailPosition(window.localStorage)).toBe("left");
    window.localStorage.setItem(RAIL_POSITION_STORAGE_KEY, "middle");
    expect(readRailPosition(window.localStorage)).toBe("left");
    expect(readRailPosition(null)).toBe("left");
  });

  it("marks only right and off on the root", () => {
    const root = document.documentElement;
    applyRailPosition(root, "right");
    expect(root.dataset.rails).toBe("right");
    applyRailPosition(root, "off");
    expect(root.dataset.rails).toBe("off");
    applyRailPosition(root, "left");
    expect(root.dataset.rails).toBeUndefined();
  });

  it("follows Settings through the storage event", () => {
    const stop = installRailPosition(window.localStorage);
    expect(writeRailPosition(window.localStorage, "off")).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: RAIL_POSITION_STORAGE_KEY }));
    expect(document.documentElement.dataset.rails).toBe("off");
    stop();
  });
});
