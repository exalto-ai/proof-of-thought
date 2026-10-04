/**
 * The app-wide Settings window. Opened from Proof of Thought → Settings… (⌘,)
 * or from the AI sidebar; there is only ever one.
 *
 * Every preference here either lives in shared local storage (theme) or in an
 * authority that already exists — the login Keychain for provider keys and the
 * daemon for connected-app credentials. This window holds no state of its own.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PROVIDER_KEYS_CHANGED_STORAGE_KEY, safeLocalStorage } from "./ai-support";
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

type Connection = { mcp_url: string; token: string; stdio_command: string };

const storage = safeLocalStorage(window);
const isTauri = Boolean(
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
);
const nativeWindow = isTauri ? getCurrentWindow() : null;

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`missing settings element: ${selector}`);
  return value;
}

const toast = required<HTMLElement>("#toast");
let toastTimer: number | null = null;
function notify(message: string, kind: "info" | "error" = "info") {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.hidden = false;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), kind === "error" ? 6000 : 2600);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- theme

installTheme(storage, nativeWindow);
const themeButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-theme-choice]"),
];

function renderTheme(theme: ThemePreference) {
  for (const button of themeButtons) {
    const checked = button.dataset.themeChoice === theme;
    button.setAttribute("aria-checked", String(checked));
    button.tabIndex = checked ? 0 : -1;
  }
}

function chooseTheme(theme: ThemePreference) {
  if (!writeTheme(storage, theme)) {
    notify("The theme changed, but could not be saved for next launch.", "error");
  }
  applyTheme(document.documentElement, theme, nativeWindow);
  renderTheme(theme);
}

for (const [index, button] of themeButtons.entries()) {
  button.addEventListener("click", () => {
    const value = button.dataset.themeChoice;
    if (isThemePreference(value)) chooseTheme(value);
  });
  button.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = themeButtons[(index + step + themeButtons.length) % themeButtons.length];
    next.focus();
    next.click();
  });
}
renderTheme(readTheme(storage));
window.addEventListener("storage", () => renderTheme(readTheme(storage)));

// ---------------------------------------------------------------- provider keys

/** Tell open document windows to re-check which providers have a key. */
function announceProviderChange() {
  try {
    storage?.setItem(PROVIDER_KEYS_CHANGED_STORAGE_KEY, String(Date.now()));
  } catch {
    // Document windows also re-check when they regain focus.
  }
}

function announcingBridge(bridge: ProProviderBridge): ProProviderBridge {
  return {
    list: () => bridge.list(),
    configure: (provider) =>
      bridge.configure(provider).finally(announceProviderChange),
    remove: (provider) => bridge.remove(provider).finally(announceProviderChange),
  };
}

const providers = installProProvider(document, {
  bridge: isTauri ? announcingBridge(tauriProProviderBridge()) : null,
  onNotice: notify,
});
providers.setActive(true);

// ---------------------------------------------------------------- connected apps

const scope = required<HTMLSelectElement>("#reviewer-scope");
const documentField = required<HTMLElement>("#reviewer-document-field");
const documentSelect = required<HTMLSelectElement>("#reviewer-document");
let documents: DocumentSummary[] = [];

const reviewers = installReviewerConnections(document, {
  onNotice: notify,
  defaultScope: "all",
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
  required<HTMLFormElement>("#reviewer-form"),
  { attributes: true, attributeFilter: ["hidden"] },
);

async function connectReviewers() {
  if (!isTauri) {
    notify("Open Settings through the native app to manage connected apps.", "error");
    return;
  }
  try {
    const connection = await invoke<Connection>("connection");
    const mcp = new Mcp(connection.mcp_url, connection.token);
    reviewers.setApi(new EditorApi(connection.mcp_url, connection.token));
    reviewers.setExecutable(connection.stdio_command);
    reviewers.setOpen(true);
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
  reviewers.setOpen(true);
});
