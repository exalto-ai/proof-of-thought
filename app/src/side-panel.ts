import { ICONS, icon } from "./icons";
import { readItem, writeItem } from "./storage";

/** The editor keeps at least this much room however the panels are dragged. */
const EDITOR_MIN_WIDTH = 420;
const KEYBOARD_STEP = 16;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export type SidePanelOptions = {
  storage: Storage | null;
  panel: HTMLElement;
  resizer: HTMLElement;
  toggle: HTMLButtonElement;
  /** Which window edge the panel sits against; decides drag direction and icon. */
  side: "left" | "right";
  /** What the toggle shows and hides, e.g. "AI sidebar". */
  label: string;
  openStorageKey: string;
  widthStorageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** Called after the panel is shown or hidden. */
  onVisibilityChange?: (open: boolean) => void;
};

export type SidePanelController = {
  isOpen(): boolean;
  destroy(): void;
};

/**
 * Clamp a panel width so it stays within its own bounds and leaves the
 * editor its minimum. `available` is the room left after any other open
 * panels.
 */
export function clampPanelWidth(
  width: number,
  available: number,
  minWidth: number,
  maxWidth: number,
): number {
  const max = Math.max(minWidth, Math.min(maxWidth, available - EDITOR_MIN_WIDTH));
  return Math.round(Math.min(max, Math.max(minWidth, width)));
}

function toggleIcon(side: "left" | "right"): SVGSVGElement {
  const svg = icon(side === "left" ? ICONS.panelLeft : ICONS.panelRight);
  // The icon's own sidebar column fills in while the panel shows, so the
  // state reads at a glance rather than only through a background tint.
  const fill = document.createElementNS(SVG_NAMESPACE, "path");
  fill.setAttribute("class", "panel-fill");
  fill.setAttribute(
    "d",
    side === "left"
      ? "M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4z"
      : "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z",
  );
  svg.prepend(fill);
  return svg;
}

/**
 * A workspace side panel: shown and hidden only by its title-bar toggle,
 * resized by dragging its border (or arrow keys on the focused border), with
 * both choices remembered. It is open by default.
 */
export function installSidePanel(
  root: Document,
  options: SidePanelOptions,
): SidePanelController {
  const { storage, panel, resizer, toggle, side } = options;
  const disposers: Array<() => void> = [];
  let open = readItem(storage, options.openStorageKey) !== "false";
  const savedWidth = Number(readItem(storage, options.widthStorageKey));
  let width = Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : options.defaultWidth;

  toggle.replaceChildren(toggleIcon(side));
  toggle.setAttribute("aria-label", options.label[0].toUpperCase() + options.label.slice(1));

  function listen(target: EventTarget, event: string, listener: (event: Event) => void) {
    target.addEventListener(event, listener);
    disposers.push(() => target.removeEventListener(event, listener));
  }

  /** Workspace width minus every other open side panel. */
  function availableWidth(): number {
    const workspace = panel.parentElement;
    const total = workspace?.getBoundingClientRect().width || window.innerWidth;
    let others = 0;
    for (const sibling of workspace?.querySelectorAll<HTMLElement>("[data-side-panel]") ?? []) {
      if (sibling !== panel && !sibling.hidden) others += sibling.getBoundingClientRect().width;
    }
    return total - others;
  }

  function clamp(next: number): number {
    return clampPanelWidth(next, availableWidth(), options.minWidth, options.maxWidth);
  }

  function applyWidth(next: number, persist: boolean) {
    width = clamp(next);
    panel.style.setProperty("--panel-width", `${width}px`);
    resizer.setAttribute("aria-valuemin", String(options.minWidth));
    resizer.setAttribute("aria-valuemax", String(clamp(Infinity)));
    resizer.setAttribute("aria-valuenow", String(width));
    if (persist) writeItem(storage, options.widthStorageKey, String(width));
    // Provenance rails measure editor geometry, which this just changed.
    window.dispatchEvent(new Event("resize"));
  }

  function render() {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.title = `${open ? "Hide" : "Show"} ${options.label}`;
    panel.hidden = !open;
    resizer.hidden = !open;
  }

  function setOpen(next: boolean) {
    if (next === open) return;
    const hadFocus = panel.contains(root.activeElement);
    open = next;
    writeItem(storage, options.openStorageKey, String(open));
    render();
    if (open) applyWidth(width, false);
    else window.dispatchEvent(new Event("resize"));
    if (!open && hadFocus) toggle.focus();
    options.onVisibilityChange?.(open);
  }

  listen(toggle, "click", () => setOpen(!open));

  // Dragging toward the editor widens the panel.
  const direction = side === "left" ? 1 : -1;
  let dragStart: { x: number; width: number } | null = null;
  listen(resizer, "pointerdown", (event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    pointer.preventDefault();
    dragStart = { x: pointer.clientX, width };
    resizer.setPointerCapture?.(pointer.pointerId);
    root.documentElement.classList.add("is-resizing-panel");
    resizer.classList.add("is-dragging");
  });
  listen(resizer, "pointermove", (event) => {
    if (!dragStart) return;
    const pointer = event as PointerEvent;
    applyWidth(dragStart.width + direction * (pointer.clientX - dragStart.x), false);
  });
  const endDrag = () => {
    if (!dragStart) return;
    dragStart = null;
    root.documentElement.classList.remove("is-resizing-panel");
    resizer.classList.remove("is-dragging");
    applyWidth(width, true);
  };
  listen(resizer, "pointerup", endDrag);
  listen(resizer, "pointercancel", endDrag);
  listen(resizer, "dblclick", () => applyWidth(options.defaultWidth, true));
  listen(resizer, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    applyWidth(width + direction * step * KEYBOARD_STEP, true);
  });
  listen(window, "resize", () => {
    if (!open) return;
    const next = clamp(width);
    if (next !== width) {
      width = next;
      panel.style.setProperty("--panel-width", `${width}px`);
    }
  });
  listen(root, "keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    if (!open || !panel.contains(root.activeElement)) return;
    // The toggle owns visibility; Escape only hands focus back to writing.
    event.preventDefault();
    event.stopImmediatePropagation();
    const editor = root.querySelector<HTMLElement>("#editor .tiptap");
    (editor ?? toggle).focus();
  });

  render();
  if (open) applyWidth(width, false);

  return {
    isOpen: () => open,
    destroy() {
      for (const dispose of disposers.splice(0)) dispose();
      root.documentElement.classList.remove("is-resizing-panel");
    },
  };
}
