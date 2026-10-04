/**
 * The app-wide Settings window. Opened from Proof of Thought → Settings… (⌘,)
 * or from the AI sidebar; there is only ever one.
 *
 * Every preference here either lives in shared local storage (theme) or in an
 * authority that already exists — the login Keychain for provider keys and the
 * daemon for connected-app credentials. This window holds no state of its own.
 */
import { invoke } from "@tauri-apps/api/core";
import { PROVIDER_KEYS_CHANGED_STORAGE_KEY } from "./ai-support";
import { readItem, safeLocalStorage, writeItem } from "./storage";
import { ICONS, icon } from "./icons";
import { EditorApi } from "./editor-api";
import { Mcp, type DocumentSummary } from "./mcp";
import { installProProvider } from "./pro-provider";
import {
  tauriProProviderBridge,
  type ProProviderBridge,
} from "./pro-provider-bridge";
import { installReviewerConnections } from "./reviewer-connections";
import {
  applyTheme,
  installTheme,
  isThemePreference,
  readTheme,
  writeTheme,
  type ThemePreference,
} from "./theme";
import {
  isToolbarPosition,
  readToolbarPosition,
  writeToolbarPosition,
  type ToolbarPosition,
} from "./toolbar-position";
import { required } from "./dom";
import { installToast, oneLine } from "./notices";
import { isTauri, nativeWindow as getNativeWindow } from "./tauri";

type Connection = { mcp_url: string; token: string; stdio_command: string };

const storage = safeLocalStorage();
const nativeWindow = getNativeWindow();
const notify = installToast(required<HTMLElement>(document, "#toast", "settings"));
const reason = (error: unknown) => oneLine(error, "unknown error");

// ---------------------------------------------------------------- tabs

/**
 * Toolbar tabs, as in a Mac app's Settings window: one pane at a time, the
 * window titled after it, and the last pane remembered.
 */
const SETTINGS_TAB_STORAGE_KEY = "thought.settings-tab.v1";
const tabs = [...document.querySelectorAll<HTMLButtonElement>('.settings-tabs [role="tab"]')];

for (const tab of tabs) {
  const name = tab.dataset.icon as keyof typeof ICONS | undefined;
  if (name && name in ICONS) tab.prepend(icon(ICONS[name]));
}

function selectTab(pane: string, focus = false) {
  const chosen = tabs.find((tab) => tab.dataset.pane === pane) ?? tabs[0];
  for (const tab of tabs) {
    const selected = tab === chosen;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
    if (panel) panel.hidden = !selected;
  }
  if (focus) chosen.focus();
  writeItem(storage, SETTINGS_TAB_STORAGE_KEY, chosen.dataset.pane ?? "general");
  document.title = chosen.textContent?.trim() || "Settings";
  void nativeWindow?.setTitle(document.title);
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectTab(tab.dataset.pane ?? "general"));
  tab.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.pane ?? "general", true);
  });
}
// ⌘1, ⌘2, ⌘3 switch panes, as in most Mac Settings windows.
document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
  const tab = tabs[Number(event.key) - 1];
  if (!tab) return;
  event.preventDefault();
  selectTab(tab.dataset.pane ?? "general", true);
});
selectTab(readItem(storage, SETTINGS_TAB_STORAGE_KEY) ?? "general");

// ---------------------------------------------------------------- appearance

/**
 * A radiogroup of segmented buttons. Arrow keys move the choice, as in a
 * native segmented control, and only the checked button is in the tab order.
 */
function installChoice<T extends string>(
  attribute: string,
  isValue: (value: unknown) => value is T,
  read: () => T,
  choose: (value: T) => void,
) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`[${attribute}]`)];
  const render = () => {
    const current = read();
    for (const button of buttons) {
      const checked = button.getAttribute(attribute) === current;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  };
  for (const [index, button] of buttons.entries()) {
    button.addEventListener("click", () => {
      const value = button.getAttribute(attribute);
      if (!isValue(value)) return;
      choose(value);
      render();
    });
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
      if (step === 0) return;
      event.preventDefault();
      const next = buttons[(index + step + buttons.length) % buttons.length];
      next.focus();
      next.click();
    });
  }
  render();
  window.addEventListener("storage", render);
}

installTheme(storage, nativeWindow);
installChoice<ThemePreference>(
  "data-theme-choice",
  isThemePreference,
  () => readTheme(storage),
  (theme) => {
    if (!writeTheme(storage, theme)) {
      notify("The theme changed, but could not be saved for next launch.", "error");
    }
    applyTheme(document.documentElement, theme, nativeWindow);
  },
);

// Settings has no toolbar of its own; document windows follow the storage event.
installChoice<ToolbarPosition>(
  "data-toolbar-choice",
  isToolbarPosition,
  () => readToolbarPosition(storage),
  (position) => {
    if (!writeToolbarPosition(storage, position)) {
      notify("Could not save the toolbar position.", "error");
    }
  },
);

// ---------------------------------------------------------------- provider keys

/** Tell open document windows to re-check which providers have a key. */
function announceProviderChange() {
  // If this fails, document windows still re-check when they regain focus.
  writeItem(storage, PROVIDER_KEYS_CHANGED_STORAGE_KEY, String(Date.now()));
}

function announcingBridge(bridge: ProProviderBridge): ProProviderBridge {
  return {
    list: () => bridge.list(),
    configure: (provider) =>
      bridge.configure(provider).finally(announceProviderChange),
    remove: (provider) => bridge.remove(provider).finally(announceProviderChange),
  };
}

installProProvider(document, {
  bridge: isTauri() ? announcingBridge(tauriProProviderBridge()) : null,
  onNotice: notify,
});

// ---------------------------------------------------------------- connected apps

const scope = required<HTMLSelectElement>(document, "#reviewer-scope", "settings");
const documentField = required<HTMLElement>(document, "#reviewer-document-field", "settings");
const documentSelect = required<HTMLSelectElement>(document, "#reviewer-document", "settings");
let documents: DocumentSummary[] = [];

const reviewers = installReviewerConnections(document, {
  onNotice: notify,
  onEditDocument(documentId) {
    if (documentId && documents.some((value) => value.doc_id === documentId)) {
      documentSelect.value = documentId;
      selectDocument();
    }
  },
});

function selectDocument() {
  const chosen = documents.find((value) => value.doc_id === documentSelect.value);
  reviewers.setDocument(
    chosen ? { id: chosen.doc_id, title: chosen.title } : null,
  );
}

function renderDocumentField() {
  documentField.hidden = scope.value !== "current";
}

function renderDocuments() {
  documentSelect.replaceChildren(
    ...documents.map((value) => {
      const option = document.createElement("option");
      option.value = value.doc_id;
      option.textContent = value.title || "Untitled";
      return option;
    }),
  );
  selectDocument();
}

scope.addEventListener("change", renderDocumentField);
documentSelect.addEventListener("change", selectDocument);
// The form toggles scope programmatically when it opens; follow it.
new MutationObserver(renderDocumentField).observe(
  required<HTMLFormElement>(document, "#reviewer-form", "settings"),
  { attributes: true, attributeFilter: ["hidden"] },
);

async function connectReviewers() {
  if (!isTauri()) {
    notify("Open Settings through the native app to manage connected apps.", "error");
    return;
  }
  try {
    const connection = await invoke<Connection>("connection");
    const mcp = new Mcp(connection.mcp_url, connection.token);
    reviewers.setApi(new EditorApi(connection.mcp_url, connection.token));
    reviewers.setExecutable(connection.stdio_command);
    void reviewers.refresh();
    await mcp.connect();
    documents = await mcp.listDocuments();
    renderDocuments();
  } catch (error) {
    notify(`Could not reach the daemon: ${reason(error)}`, "error");
  }
}

renderDocumentField();
void connectReviewers();

// Re-check status whenever Settings comes back to the front.
window.addEventListener("focus", () => {
  void reviewers.refresh();
});
