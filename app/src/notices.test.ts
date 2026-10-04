import { afterEach, describe, expect, it, vi } from "vitest";
import { installToast, oneLine } from "./notices";

afterEach(() => {
  vi.useRealTimers();
});

describe("notices", () => {
  it("says an error in one bounded line, with a fallback for empty ones", () => {
    expect(oneLine(new Error("bad\n\tthing"), "fallback")).toBe("bad thing");
    expect(oneLine("   ", "fallback")).toBe("fallback");
    expect(oneLine("x".repeat(20), "fallback", 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("lets errors linger longer than confirmations", () => {
    vi.useFakeTimers();
    const toast = document.createElement("div");
    const notify = installToast(toast);

    notify("Saved");
    vi.advanceTimersByTime(2600);
    expect(toast.hidden).toBe(true);

    notify("Failed", "error");
    expect(toast.dataset.kind).toBe("error");
    vi.advanceTimersByTime(2600);
    expect(toast.hidden).toBe(false);
    vi.advanceTimersByTime(3400);
    expect(toast.hidden).toBe(true);
  });
});
