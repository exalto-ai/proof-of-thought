import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampPanelWidth, installSidePanel } from "./side-panel";
import { memoryStorage } from "./test-storage";

beforeEach(() => {
  document.body.innerHTML = `
    <button id="toggle"></button>
    <div class="workspace">
      <aside id="left" data-side-panel></aside>
      <div id="left-resizer"></div>
      <main></main>
      <aside id="right" data-side-panel style="width: 300px"></aside>
    </div>
  `;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function install(storage = memoryStorage()) {
  const panel = document.querySelector<HTMLElement>("#left")!;
  vi.spyOn(panel.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 1200 } as DOMRect);
  vi.spyOn(document.querySelector<HTMLElement>("#right")!, "getBoundingClientRect")
    .mockReturnValue({ width: 300 } as DOMRect);
  const controller = installSidePanel(document, {
    storage,
    panel,
    resizer: document.querySelector<HTMLElement>("#left-resizer")!,
    toggle: document.querySelector<HTMLButtonElement>("#toggle")!,
    side: "left",
    label: "documents sidebar",
    openStorageKey: "open",
    widthStorageKey: "width",
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 420,
  });
  return { controller, panel, storage };
}

describe("side panel", () => {
  it("never squeezes the editor or the panel below their minimums", () => {
    expect(clampPanelWidth(100, 1200, 280, 720)).toBe(280);
    expect(clampPanelWidth(2000, 1200, 280, 720)).toBe(720);
    expect(clampPanelWidth(600, 900, 280, 720)).toBe(480);
    expect(clampPanelWidth(600, 500, 280, 720)).toBe(280);
  });

  it("is open by default and labelled for its side", () => {
    const { controller, panel } = install();
    const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
    expect(controller.isOpen()).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-label")).toBe("Documents sidebar");
    expect(toggle.title).toBe("Hide documents sidebar");
    controller.destroy();
  });

  it("widens a left panel when its border is dragged right", () => {
    const { controller, panel, storage } = install();
    const resizer = document.querySelector<HTMLElement>("#left-resizer")!;
    resizer.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 240 }));
    resizer.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    // Only the border being dragged is marked, not every panel's border.
    expect(resizer.classList.contains("is-dragging")).toBe(true);
    resizer.dispatchEvent(new PointerEvent("pointerup", { clientX: 300 }));
    expect(panel.style.getPropertyValue("--panel-width")).toBe("300px");
    expect(resizer.classList.contains("is-dragging")).toBe(false);
    expect(storage.getItem("width")).toBe("300");
    controller.destroy();
  });

  it("leaves the editor its room after the other open panel", () => {
    const { controller, panel } = install();
    const resizer = document.querySelector<HTMLElement>("#left-resizer")!;
    // 1200 wide, 300 taken on the right, 420 kept for the editor: at most 420
    // by its own limit, and 480 by the room left, so 420.
    for (let i = 0; i < 40; i++) {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    }
    expect(panel.style.getPropertyValue("--panel-width")).toBe("420px");
    controller.destroy();
  });
});
