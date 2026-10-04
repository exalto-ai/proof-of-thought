import { describe, expect, it } from "vitest";
import { readItem, safeLocalStorage, writeItem } from "./storage";
import { memoryStorage } from "./test-storage";

const blocked: Storage = {
  ...memoryStorage(),
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

describe("guarded storage", () => {
  it("reads and writes through to available storage", () => {
    const storage = memoryStorage();
    expect(writeItem(storage, "k", "v")).toBe(true);
    expect(readItem(storage, "k")).toBe("v");
  });

  it("falls back instead of throwing when storage is missing or blocked", () => {
    expect(readItem(null, "k")).toBeNull();
    expect(writeItem(null, "k", "v")).toBe(false);
    expect(readItem(blocked, "k")).toBeNull();
    expect(writeItem(blocked, "k", "v")).toBe(false);
    const host = {
      get localStorage(): Storage {
        throw new Error("denied");
      },
    };
    expect(safeLocalStorage(host)).toBeNull();
  });
});
