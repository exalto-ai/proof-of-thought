import { ICONS, icon } from "./icons";
import { readItem, safeLocalStorage, writeItem } from "./storage";
import type { ChatSuggestionInput } from "./editor-api";
import type { ProProvider, ProProviderBridge } from "./pro-provider-bridge";
import type { ProChatBridge } from "./pro-chat-bridge";
import { installProChat, type ProChatDocument } from "./pro-chat";

export const AI_SIDEBAR_OPEN_STORAGE_KEY = "thought.ai-sidebar-open.v1";
export const AI_SIDEBAR_WIDTH_STORAGE_KEY = "thought.ai-sidebar-width.v1";
/** Settings bumps this after a key changes so open windows re-check. */
export const PROVIDER_KEYS_CHANGED_STORAGE_KEY = "thought.provider-keys-changed";

export const SIDEBAR_MIN_WIDTH = 280;
export const SIDEBAR_DEFAULT_WIDTH = 360;
const SIDEBAR_MAX_WIDTH = 720;
/** The editor keeps at least this much room when the sidebar is dragged wide. */
const EDITOR_MIN_WIDTH = 420;
const KEYBOARD_STEP = 16;

type AiSupportOptions = {
  storage?: Storage | null;
  providerBridge?: ProProviderBridge | null;
  chatBridge?: ProChatBridge | null;
  suggestChatResponse?: (input: ChatSuggestionInput) => Promise<unknown>;
  openSettings?: () => void | Promise<void>;
  onNotice?: (message: string, kind?: "info" | "error") => void;
};

type AiSupportController = {
  setCurrentDocument(context: ProChatDocument | null): void;
  destroy(): void;
};

function required<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing AI sidebar element: ${selector}`);
  return value;
}

/** The sidebar starts open unless this user last closed it. */
function readSidebarOpen(storage: Storage | null): boolean {
  return readItem(storage, AI_SIDEBAR_OPEN_STORAGE_KEY) !== "false";
}

export function clampSidebarWidth(width: number, available: number): number {
  const max = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, available - EDITOR_MIN_WIDTH),
  );
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function readSidebarWidth(storage: Storage | null): number {
  const value = Number(readItem(storage, AI_SIDEBAR_WIDTH_STORAGE_KEY));
  return Number.isFinite(value) && value > 0 ? value : SIDEBAR_DEFAULT_WIDTH;
}

function sidebarToggleIcon(): SVGSVGElement {
  const svg = icon(ICONS.panelRight);
  // Filled when the sidebar is showing, so the state reads at a glance rather
  // than only through a background tint.
  const fill = document.createElementNS("http://www.w3.org/2000/svg", "path");
  fill.setAttribute("class", "panel-fill");
  fill.setAttribute("d", "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z");
  svg.prepend(fill);
  return svg;
}

/**
 * Own the document window's AI sidebar: visibility, width, and whether chat
 * is available. Provider keys and connected apps are configured in Settings;
 * this only reads whether a key exists, never the key itself.
 */
export function installAiSupport(
  root: Document,
  options: AiSupportOptions = {},
): AiSupportController {
  const storage = options.storage === undefined
    ? safeLocalStorage()
    : options.storage;
  const toggle = required<HTMLButtonElement>(root, "#ai-support-toggle");
  toggle.replaceChildren(sidebarToggleIcon());
  toggle.setAttribute("aria-label", "AI sidebar");
  const sidebar = required<HTMLElement>(root, "#ai-support-sidebar");
  const resizer = required<HTMLElement>(root, "#ai-sidebar-resizer");
  const setupPanel = required<HTMLElement>(root, "#ai-chat-setup");
  const chatPanel = required<HTMLElement>(root, "#pro-chat");
  const providerSelect = required<HTMLSelectElement>(root, "#pro-chat-provider");
  const settingsButtons = [
    required<HTMLButtonElement>(root, "#ai-open-settings"),
    required<HTMLButtonElement>(root, "#ai-chat-setup-open"),
  ];
  const disposers: Array<() => void> = [];
  const chat = installProChat(root, {
    bridge: options.chatBridge,
    suggestResponse: options.suggestChatResponse,
    onNotice: options.onNotice,
  });
  let sidebarOpen = readSidebarOpen(storage);
  let width = readSidebarWidth(storage);
  let configured = new Set<ProProvider>();
  let providersKnown = false;
  let providerRequest = 0;

  function listen(
    target: EventTarget,
    event: string,
    listener: (event: Event) => void,
  ) {
    target.addEventListener(event, listener);
    disposers.push(() => target.removeEventListener(event, listener));
  }

  function availableWidth(): number {
    return sidebar.parentElement?.getBoundingClientRect().width || window.innerWidth;
  }

  function applyWidth(next: number, persist: boolean) {
    width = clampSidebarWidth(next, availableWidth());
    sidebar.style.setProperty("--ai-sidebar-width", `${width}px`);
    resizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
    resizer.setAttribute("aria-valuemax", String(clampSidebarWidth(Infinity, availableWidth())));
    resizer.setAttribute("aria-valuenow", String(width));
    if (persist) writeItem(storage, AI_SIDEBAR_WIDTH_STORAGE_KEY, String(width));
    // Provenance rails measure editor geometry, which this just changed.
    window.dispatchEvent(new Event("resize"));
  }

  /** With one configured provider there is nothing to choose. */
  function preferConfiguredProvider() {
    if (providerSelect.value !== "" || configured.size !== 1) return;
    providerSelect.value = [...configured][0];
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function render() {
    const hasKey = configured.size > 0;
    for (const option of providerSelect.options) {
      if (option.value) option.disabled = !configured.has(option.value as ProProvider);
    }
    toggle.setAttribute("aria-expanded", String(sidebarOpen));
    toggle.title = sidebarOpen ? "Hide AI sidebar" : "Show AI sidebar";
    sidebar.hidden = !sidebarOpen;
    resizer.hidden = !sidebarOpen;
    setupPanel.hidden = !providersKnown || hasKey;
    chatPanel.hidden = !hasKey;
    chat.setActive(sidebarOpen && hasKey);
    if (sidebarOpen && hasKey) preferConfiguredProvider();
  }

  async function refreshProviders() {
    const bridge = options.providerBridge;
    const request = ++providerRequest;
    if (!bridge) {
      configured = new Set();
      providersKnown = true;
      render();
      return;
    }
    try {
      const values = await bridge.list();
      if (request !== providerRequest) return;
      configured = new Set(
        values.filter((value) => value.configured).map((value) => value.provider),
      );
      providersKnown = true;
      render();
    } catch {
      if (request !== providerRequest) return;
      providersKnown = true;
      render();
    }
  }

  function focusEditorOrToggle() {
    const editor = root.querySelector<HTMLElement>("#editor .tiptap");
    (editor ?? toggle).focus();
  }

  function open() {
    if (sidebarOpen) return;
    sidebarOpen = true;
    writeItem(storage, AI_SIDEBAR_OPEN_STORAGE_KEY, "true");
    render();
    applyWidth(width, false);
  }

  function close() {
    if (!sidebarOpen) return;
    const hadFocus = sidebar.contains(root.activeElement);
    sidebarOpen = false;
    writeItem(storage, AI_SIDEBAR_OPEN_STORAGE_KEY, "false");
    render();
    window.dispatchEvent(new Event("resize"));
    if (hadFocus) toggle.focus();
  }

  listen(toggle, "click", () => (sidebarOpen ? close() : open()));
  for (const button of settingsButtons) {
    listen(button, "click", () => void options.openSettings?.());
  }

  let dragStart: { x: number; width: number } | null = null;
  listen(resizer, "pointerdown", (event) => {
    const pointer = event as PointerEvent;
    if (pointer.button !== 0) return;
    pointer.preventDefault();
    dragStart = { x: pointer.clientX, width };
    resizer.setPointerCapture?.(pointer.pointerId);
    root.documentElement.classList.add("is-resizing-sidebar");
  });
  listen(resizer, "pointermove", (event) => {
    if (!dragStart) return;
    const pointer = event as PointerEvent;
    // The sidebar is on the right: dragging left widens it.
    applyWidth(dragStart.width + dragStart.x - pointer.clientX, false);
  });
  const endDrag = () => {
    if (!dragStart) return;
    dragStart = null;
    root.documentElement.classList.remove("is-resizing-sidebar");
    applyWidth(width, true);
  };
  listen(resizer, "pointerup", endDrag);
  listen(resizer, "pointercancel", endDrag);
  listen(resizer, "dblclick", () => applyWidth(SIDEBAR_DEFAULT_WIDTH, true));
  listen(resizer, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowLeft") applyWidth(width + KEYBOARD_STEP, true);
    else if (key === "ArrowRight") applyWidth(width - KEYBOARD_STEP, true);
    else return;
    event.preventDefault();
  });
  listen(window, "resize", () => {
    if (!sidebarOpen) return;
    const next = clampSidebarWidth(width, availableWidth());
    if (next !== width) {
      width = next;
      sidebar.style.setProperty("--ai-sidebar-width", `${width}px`);
    }
  });

  listen(window, "focus", () => void refreshProviders());
  listen(window, "storage", (event) => {
    if ((event as StorageEvent).key === PROVIDER_KEYS_CHANGED_STORAGE_KEY) {
      void refreshProviders();
    }
  });
  listen(root, "keydown", (event) => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    if (!sidebarOpen || !sidebar.contains(root.activeElement)) return;
    // The toggle owns visibility; Escape only hands focus back to writing.
    event.preventDefault();
    event.stopImmediatePropagation();
    focusEditorOrToggle();
  });

  render();
  applyWidth(width, false);
  void refreshProviders();

  return {
    setCurrentDocument(context) {
      chat.setDocument(context);
      if (sidebarOpen && configured.size > 0) preferConfiguredProvider();
    },
    destroy() {
      for (const dispose of disposers.splice(0)) dispose();
      chat.destroy();
      root.documentElement.classList.remove("is-resizing-sidebar");
    },
  };
}
