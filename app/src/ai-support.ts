import type { ChatSuggestionInput } from "./editor-api";
import type { ProProvider, ProProviderBridge } from "./pro-provider-bridge";
import type { ProChatBridge } from "./pro-chat-bridge";
import { installProChat, type ProChatDocument } from "./pro-chat";
import { required } from "./dom";
import { ICONS, icon } from "./icons";
import { installSidePanel } from "./side-panel";
import { readItem, safeLocalStorage, writeItem } from "./storage";

export const AI_SIDEBAR_OPEN_STORAGE_KEY = "thought.ai-sidebar-open.v1";
export const AI_SIDEBAR_WIDTH_STORAGE_KEY = "thought.ai-sidebar-width.v1";
export const AI_SIDEBAR_TAB_STORAGE_KEY = "thought.ai-sidebar-tab.v1";
/** Settings bumps this after a key changes so open windows re-check. */
export const PROVIDER_KEYS_CHANGED_STORAGE_KEY = "thought.provider-keys-changed";

/** The model menu's sections, plan first. */
const MENU_ORDER: readonly ProProvider[] = ["chatgpt", "openai", "anthropic"];

/** Wide enough for the composer's controls on one line, with the model's
 * name at its shortest; measured, plus a margin for font metrics. */
export const SIDEBAR_MIN_WIDTH = 340;
export const SIDEBAR_DEFAULT_WIDTH = 360;
export const SIDEBAR_MAX_WIDTH = 720;

type AiSupportOptions = {
  storage?: Storage | null;
  providerBridge?: ProProviderBridge | null;
  chatBridge?: ProChatBridge | null;
  suggestChatEdit?: (
    input: ChatSuggestionInput,
  ) => Promise<{ suggestion: { suggestion_id: string } }>;
  applyChatEdit?: (input: ChatSuggestionInput) => Promise<{ block_id: string | null }>;
  focusSuggestion?: (suggestionId: string) => void;
  focusBlock?: (blockId: string) => void;
  openSettings?: () => void | Promise<void>;
  onNotice?: (message: string, kind?: "info" | "error") => void;
};

type AiSupportController = {
  setCurrentDocument(context: ProChatDocument | null): void;
  setSuggestionStates(states: ReadonlyMap<string, string>): void;
  refreshChatFocus(): void;
  destroy(): void;
};

/**
 * Own the document window's AI sidebar: built-in chat when a provider key
 * exists, otherwise a pointer to Settings. Provider keys and connections
 * are configured in Settings; this only reads whether a key exists, never the
 * key itself. Visibility and width belong to the shared side panel.
 */
export function installAiSupport(
  root: Document,
  options: AiSupportOptions = {},
): AiSupportController {
  const storage = options.storage === undefined
    ? safeLocalStorage()
    : options.storage;
  const sidebar = required<HTMLElement>(root, "#ai-support-sidebar", "AI sidebar");
  const setupPanel = required<HTMLElement>(root, "#ai-chat-setup", "AI sidebar");
  const chatPanel = required<HTMLElement>(root, "#pro-chat", "AI sidebar");
  const planIndicator = required<HTMLElement>(root, "#pro-chat-plan", "AI sidebar");
  for (const button of chatPanel.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = button.dataset.icon as keyof typeof ICONS;
    if (name in ICONS) button.replaceChildren(icon(ICONS[name]));
  }
  const openSettings = required<HTMLButtonElement>(root, "#ai-chat-setup-open", "AI sidebar");
  required<HTMLElement>(root, "#ai-chat-setup-icon", "AI sidebar").replaceChildren(
    icon(ICONS.messageSquare),
  );
  const disposers: Array<() => void> = [];
  const chat = installProChat(root, {
    bridge: options.chatBridge,
    suggestEdit: options.suggestChatEdit,
    applyEdit: options.applyChatEdit,
    focusSuggestion: options.focusSuggestion,
    focusBlock: options.focusBlock,
    onNotice: options.onNotice,
    openSettings: () => void options.openSettings?.(),
    // OpenAI asks that chat say when it is running on the ChatGPT plan.
    onSelectionChange: (provider) => {
      planIndicator.hidden = provider !== "chatgpt";
    },
  });
  let configured = new Set<ProProvider>();
  let providersKnown = false;
  let providerRequest = 0;
  const panel = installSidePanel(root, {
    storage,
    panel: sidebar,
    resizer: required<HTMLElement>(root, "#ai-sidebar-resizer", "AI sidebar"),
    toggle: required<HTMLButtonElement>(root, "#ai-support-toggle", "AI sidebar"),
    side: "right",
    label: "AI sidebar",
    openStorageKey: AI_SIDEBAR_OPEN_STORAGE_KEY,
    widthStorageKey: AI_SIDEBAR_WIDTH_STORAGE_KEY,
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    maxWidth: SIDEBAR_MAX_WIDTH,
    onVisibilityChange: () => render(),
  });

  function listen(target: EventTarget, event: string, listener: (event: Event) => void) {
    target.addEventListener(event, listener);
    disposers.push(() => target.removeEventListener(event, listener));
  }

  function render() {
    const hasKey = configured.size > 0;
    setupPanel.hidden = !providersKnown || hasKey;
    chatPanel.hidden = !hasKey;
    chat.setProviders(MENU_ORDER.filter((name) => configured.has(name)));
    chat.setActive(panel.isOpen() && hasKey);
  }

  async function refreshProviders() {
    const bridge = options.providerBridge;
    const request = ++providerRequest;
    let values: Awaited<ReturnType<ProProviderBridge["list"]>> = [];
    try {
      values = bridge ? await bridge.list() : [];
    } catch {
      // Treated as "no keys": the sidebar points to Settings.
    }
    if (request !== providerRequest) return;
    configured = new Set(
      values.filter((value) => value.configured).map((value) => value.provider),
    );
    providersKnown = true;
    render();
  }

  listen(openSettings, "click", () => void options.openSettings?.());

  // Agent (chat) and Proof (where the text came from), one at a time.
  const tabs = [...sidebar.querySelectorAll<HTMLButtonElement>('.sidebar-tabs [role="tab"]')];
  function selectTab(name: string, focus = false) {
    const chosen = tabs.find((tab) => tab.dataset.tab === name) ?? tabs[0];
    for (const tab of tabs) {
      const selected = tab === chosen;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const pane = root.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (pane) pane.hidden = !selected;
    }
    if (focus) chosen.focus();
    writeItem(storage, AI_SIDEBAR_TAB_STORAGE_KEY, chosen.dataset.tab ?? "agent");
  }
  for (const [index, tab] of tabs.entries()) {
    listen(tab, "click", () => selectTab(tab.dataset.tab ?? "agent"));
    listen(tab, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;
      event.preventDefault();
      selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.tab ?? "agent", true);
    });
  }
  selectTab(readItem(storage, AI_SIDEBAR_TAB_STORAGE_KEY) ?? "agent");
  listen(window, "focus", () => void refreshProviders());
  listen(window, "storage", (event) => {
    if ((event as StorageEvent).key === PROVIDER_KEYS_CHANGED_STORAGE_KEY) {
      void refreshProviders();
    }
  });

  render();
  void refreshProviders();

  return {
    setCurrentDocument(context) {
      chat.setDocument(context);
    },
    setSuggestionStates(states) {
      chat.setSuggestionStates(states);
    },
    refreshChatFocus() {
      chat.refreshFocus();
    },
    destroy() {
      for (const dispose of disposers.splice(0)) dispose();
      panel.destroy();
      chat.destroy();
    },
  };
}
