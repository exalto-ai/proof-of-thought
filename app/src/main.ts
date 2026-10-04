/**
 * The window. Opens one document at a time; the switcher opens with the
 * platform accelerator and K.
 */
import { invoke } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Editor } from "@tiptap/core";
import { installAiSupport } from "./ai-support";
import { installDocumentSidebar } from "./doc-sidebar";
import { ICONS, icon } from "./icons";
import { createEditor, editorSnapshot } from "./editor";
import { EditorApi } from "./editor-api";
import { installProof } from "./proof";
import { chatStats } from "./pro-chat";
import {
  exportMarkdownDocument,
  importMarkdownDocument,
  nativeFileBridge,
} from "./files";
import { ACCEL_LABEL, accel, relabelShortcutHints } from "./keys";
import { Mcp, type DocumentSummary } from "./mcp";
import { colorFor, FALLBACK_PRESENCE_COLOR, playfulName, seedFrom } from "./names";
import { installProvenanceRails, type Rails } from "./provenance";
import { tauriProChatBridge } from "./pro-chat-bridge";
import { tauriProProviderBridge } from "./pro-provider-bridge";
import { SyncProvider, type AgentPresence, type ProviderStatus } from "./provider";
import { readItem, safeLocalStorage, safeSessionStorage, writeItem } from "./storage";
import { installTheme } from "./theme";
import { ZOOM_COMMAND_EVENT, type ZoomCommand } from "./toolbar";
import { installToolbarPosition } from "./toolbar-position";
import { installRailPosition } from "./rail-position";
import {
  installSuggestionReview,
  topLevelBlockIds,
  type SuggestionReviewController,
} from "./suggestions";
import { installToast, oneLine } from "./notices";
import { isTauri, nativeAppearance, nativeWindow } from "./tauri";

type Connection = {
  sync_url: string;
  mcp_url: string;
  token: string;
  stdio_command: string;
  /** Who this window writes as, from `thought_mcp::EDITOR_ACTOR_ID`. */
  actor_id: string;
};

const els = {
  status: document.getElementById("status")!,
  presence: document.getElementById("presence")!,
  editor: document.getElementById("editor")!,
  scrim: document.getElementById("scrim")!,
  toast: document.getElementById("toast")!,
  switcher: document.querySelector(".switcher") as HTMLElement,
  hint: document.getElementById("switcher-hint")!,
  input: document.getElementById("switcher-input") as HTMLInputElement,
  results: document.getElementById("switcher-results")!,
};

let connection: Connection;
let mcp: Mcp;
let editorApi: EditorApi;
let open: {
  doc: Y.Doc;
  awareness: Awareness;
  provider: SyncProvider;
  editor: Editor;
  rails: Rails;
  suggestions: SuggestionReviewController;
} | null = null;
let openDocId = "";
let closingAfterAutosave = false;

/**
 * Say something went wrong, where the person is already looking.
 *
 * Failures used to have nowhere to go. `refreshProvenance` swallowed its
 * errors, `boot` only wrote into the title, and everything else surfaced as
 * nothing at all — a green status dot above a window that was quietly wrong.
 */
const notify = installToast(els.toast);
const reason = (error: unknown) => oneLine(error, "unknown error", 160);

installTheme(safeLocalStorage(), nativeAppearance());
installToolbarPosition(safeLocalStorage());
installRailPosition(safeLocalStorage());

const aiSupport = installAiSupport(document, {
  providerBridge: isTauri() ? tauriProProviderBridge() : null,
  chatBridge: isTauri() ? tauriProChatBridge() : null,
  suggestChatEdit: (input) => editorApi.proposeChatSuggestion(input),
  applyChatEdit: (input) => editorApi.applyChatEdit(input),
  focusSuggestion: (suggestionId) => void focusSuggestion(suggestionId),
  focusBlock: (blockId) => focusBlock(blockId),
  openSettings: () =>
    invoke<void>("open_settings").catch((error) =>
      notify(`Could not open Settings: ${reason(error)}`, "error"),
    ),
  onNotice: notify,
});

const docSidebar = installDocumentSidebar(document, {
  storage: safeLocalStorage(),
  // Both run only after boot has connected; until then there is nothing to list.
  list: async () => (mcp ? mcp.listDocuments(500) : []),
  open: (docId) => openDocument(docId),
  create: () => createNewDocument(),
  // Native menus exist only in the app; the browser keeps its own.
  showMenu: isTauri() ? showDocumentMenu : undefined,
  onNotice: notify,
});

// The title-bar search icon opens the ⌘K switcher, the one search there is.
const docSearch = document.getElementById("doc-search")!;
docSearch.replaceChildren(icon(ICONS.search));
docSearch.addEventListener("click", () => openSwitcher());

async function visibleWordingRevision(): Promise<string | null> {
  const current = open;
  const docId = openDocId;
  if (
    !current ||
    !docId ||
    !isTauri() ||
    !current.provider.isHydrated ||
    current.provider.hasPendingChanges
  ) {
    return null;
  }
  const revision = await invoke<string>("document_wording_revision", {
    document: editorSnapshot(current.editor),
  });
  if (
    open !== current ||
    openDocId !== docId ||
    !current.provider.isHydrated ||
    current.provider.hasPendingChanges
  ) {
    return null;
  }
  return revision;
}

const proof = installProof(document, {
  lineage: (docId) => mcp.documentLineage(docId),
  activity: (docId) => editorApi.documentActivity(docId),
  suggestions: async (docId) => {
    const counts = { accepted: 0, rejected: 0, pending: 0 };
    for (const { state } of (await editorApi.listSuggestions(docId)).suggestions) {
      if (state === "accepted") counts.accepted += 1;
      else if (state === "rejected") counts.rejected += 1;
      else counts.pending += 1;
    }
    return counts;
  },
  chat: (docId) => chatStats(safeLocalStorage(), docId),
  visibleRevision: visibleWordingRevision,
  wordCount: () => open?.editor.getText().split(/\s+/).filter(Boolean).length ?? 0,
});

/**
 * Agents that have written recently.
 *
 * An agent has no session to be "in" — it connects over MCP, does something,
 * and leaves. So presence here means *recently active*, and it lapses on its
 * own rather than waiting for a disconnect that never comes.
 */
const AGENT_PRESENCE_MS = 45_000;
const activeAgents = new Map<string, { presence: AgentPresence; at: number }>();

function noteAgent(presence: AgentPresence) {
  activeAgents.set(presence.actor_id, { presence, at: Date.now() });
  renderPeers();
  scheduleProvenance();
  // Re-render when this one lapses, so the chip disappears without a further
  // edit to trigger it.
  setTimeout(renderPeers, AGENT_PRESENCE_MS + 250);
}

function liveAgents() {
  const cutoff = Date.now() - AGENT_PRESENCE_MS;
  for (const [id, entry] of activeAgents) {
    if (entry.at < cutoff) activeAgents.delete(id);
  }
  return [...activeAgents.values()];
}

/** Shown only when the daemon connection needs attention; silent when connected. */
const STATUS_TITLES: Partial<Record<ProviderStatus, string>> = {
  connecting: "Connecting to the daemon…",
  offline: "Offline — edits will sync when the daemon is back",
};

function setStatus(status: ProviderStatus) {
  els.status.dataset.state = status;
  els.status.title = STATUS_TITLES[status] ?? "";
  els.status.hidden = !STATUS_TITLES[status];
}

/**
 * The document title, shown in the native window title rather than painted
 * into the page — a heading repeated two centimetres above itself is noise.
 *
 * Derived exactly as the daemon derives it (first heading, else first non-empty
 * block), because two implementations of "what is this document called" drift
 * and then disagree in front of the user.
 */
function deriveTitle(editor: Editor): string {
  const doc = editor.state.doc;
  let title = "";
  doc.forEach((node) => {
    if (title) return;
    if (node.type.name === "heading") title = node.textContent.trim();
  });
  if (!title) {
    doc.forEach((node) => {
      if (!title && node.textContent.trim()) title = node.textContent.trim();
    });
  }
  return title.slice(0, 120) || "Untitled";
}

function refreshTitle(editor: Editor) {
  // Until the daemon delivers the document, the editor is empty, and a title
  // derived from it would flash "Untitled" in the window and the sidebar.
  if (open?.editor === editor && !open.provider.isHydrated) {
    if (openDocId) docSidebar.setCurrent(openDocId);
    return;
  }
  const title = deriveTitle(editor);
  document.title = title;
  void nativeWindow()?.setTitle(title);
  if (open?.editor === editor && openDocId) {
    docSidebar.setCurrent(openDocId, title);
    const current = open;
    aiSupport.setCurrentDocument({
      id: openDocId,
      title,
      snapshot: () => editorSnapshot(editor),
      blockIds: () => topLevelBlockIds(editor, current.doc),
      waitUntilSaved: () => current.provider.waitUntilSaved(),
      selectedText: () => {
        const { from, to } = editor.state.selection;
        return from === to ? null : editor.state.doc.textBetween(from, to, "\n", "\n");
      },
    });
  }
}

/** Show a suggestion a chat reply links to, loading it first if it is new. */
async function focusSuggestion(suggestionId: string) {
  const suggestions = open?.suggestions;
  if (!suggestions || suggestions.focus(suggestionId)) return;
  await suggestions.refresh();
  if (open?.suggestions === suggestions && !suggestions.focus(suggestionId)) {
    notify("That suggestion was already accepted or rejected.");
  }
}

/** Put the caret at the start of a block chat edited, and bring it into view. */
function focusBlock(blockId: string) {
  if (!open) return;
  const { editor, doc } = open;
  const index = topLevelBlockIds(editor, doc).indexOf(blockId);
  if (index < 0) {
    notify("That part of the note is no longer there.");
    return;
  }
  let position = 0;
  editor.state.doc.forEach((_node, offset, at) => {
    if (at === index) position = offset;
  });
  editor.chain().focus().setTextSelection(position + 1).scrollIntoView().run();
}

/** Show or hide one peer's caret label from outside the editor. */
function pointAt(peerId: number, pointed: boolean) {
  document
    .querySelectorAll(`.peer-caret[data-peer="${peerId}"]`)
    .forEach((caret) => caret.classList.toggle("is-pointed", pointed));
}

function renderPeers() {
  if (!open) return;
  renderPresence(open.awareness, open.doc.clientID);
}

/**
 * Remember which document this window had open.
 *
 * Session storage is per window, so two windows no longer overwrite each
 * other's idea of "the last document" — which they did, and meant opening a
 * second window could yank the first one somewhere else on the next launch.
 * The shared copy survives as the starting point for a brand-new window.
 */
function rememberOpenDocument(docId: string) {
  writeItem(safeSessionStorage(), "thought.last", docId);
  writeItem(safeLocalStorage(), "thought.last", docId);
}

function lastOpenDocument(): string | null {
  return (
    readItem(safeSessionStorage(), "thought.last") ??
    readItem(safeLocalStorage(), "thought.last")
  );
}

function initials(name: string): string {
  return name
    .split(/[\s:_-]+/)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function renderPresence(awareness: Awareness, self: number) {
  const others = [...awareness.getStates().entries()].filter(([id]) => id !== self);
  const windows = others.map(([id, state]) => {
    const user = (state as { user?: { name: string; color: string } }).user;
    const name = user?.name ?? "Someone";
    const chip = document.createElement("span");
    chip.className = "who";
    chip.style.setProperty("--who", user?.color ?? FALLBACK_PRESENCE_COLOR);
    // Initials of both words, so two peers are told apart at a glance.
    chip.textContent = initials(name);
    chip.title = `${name} — click to find their cursor`;

    // Pointing at a chip points at that peer's caret, which is otherwise a
    // 2px line somewhere in the document.
    chip.addEventListener("mouseenter", () => pointAt(id, true));
    chip.addEventListener("mouseleave", () => pointAt(id, false));
    chip.addEventListener("click", () => {
      const caret = document.querySelector(`.peer-caret[data-peer="${id}"]`);
      caret?.scrollIntoView({ behavior: "smooth", block: "center" });
      pointAt(id, true);
      setTimeout(() => pointAt(id, false), 1800);
    });
    return chip;
  });

  // Agents are shown differently on purpose: a window is *present*, an agent
  // has *just written*. Marking them the same would claim a kind of liveness
  // agents do not have.
  const agents = liveAgents().map(({ presence, at }) => {
    const chip = document.createElement("span");
    chip.className = "who is-agent";
    chip.style.setProperty("--who", colorFor(seedFrom(presence.actor_id)));
    chip.textContent = initials(presence.name || presence.actor_id);
    const model = presence.model ? ` · ${presence.model}` : "";
    chip.title = `${presence.name}${model} — wrote ${ago(at)}, hover to see where`;

    // Pointing at an agent's chip lights the blocks it wrote, the same bargain
    // the window chips make with carets. Deliberately not offered for window
    // chips: every window on this device writes as one actor, so lighting them
    // would highlight the user's own blocks as if a peer had written them.
    chip.addEventListener("mouseenter", () => open?.rails.highlight(presence.actor_id));
    chip.addEventListener("mouseleave", () => open?.rails.highlight(null));
    return chip;
  });

  els.presence.replaceChildren(...agents, ...windows);
}

async function canLeaveCurrentDocument(): Promise<boolean> {
  if (!open?.provider.hasPendingChanges) return true;
  if (await open.provider.waitUntilSaved()) return true;
  notify(
    "This document still has changes waiting to autosave. Reconnect before switching.",
    "error",
  );
  return false;
}

async function openDocument(docId: string): Promise<boolean> {
  if (open && openDocId === docId) {
    open.editor.commands.focus();
    return true;
  }
  if (!(await canLeaveCurrentDocument())) return false;
  aiSupport.setCurrentDocument(null);
  proof.setDocument(null);
  open?.suggestions.destroy();
  open?.rails.destroy();
  open?.provider.destroy();
  open?.editor.destroy();
  els.editor.replaceChildren();

  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const provider = new SyncProvider(
    connection.sync_url,
    connection.token,
    docId,
    doc,
    awareness,
    setStatus,
    noteAgent,
  );

  // A window has no name of its own, and "Window 72" tells you nothing. Both
  // name and colour derive from the Yjs client id, so a peer keeps the same
  // identity for as long as it is connected.
  const user = {
    name: playfulName(doc.clientID),
    color: colorFor(doc.clientID),
    id: doc.clientID,
  };
  const editor = createEditor(
    document.body,
    els.editor,
    doc,
    awareness,
    provider,
    user,
  );
  awareness.setLocalStateField("user", user);

  const rails = installProvenanceRails(editor, doc, els.editor, connection.actor_id);
  const suggestions = installSuggestionReview(editor, doc, docId, editorApi, {
    beforeDecision: () => provider.waitUntilSaved(),
    onNotice: notify,
    onStates: (states) => aiSupport.setSuggestionStates(states),
  });

  provider.connect();
  open = { doc, awareness, provider, editor, rails, suggestions };
  openDocId = docId;
  proof.setDocument(docId);

  // Exposed in development so the editor can be driven directly. Synthetic
  // key events do not reach ProseMirror's input handling reliably, which makes
  // anything keyboard-driven hard to check any other way.
  if (import.meta.env?.DEV) {
    (window as unknown as { __thought?: unknown }).__thought = { editor, doc, provider };
  }

  editor.on("update", () => refreshTitle(editor));
  editor.on("update", scheduleProvenance);
  editor.on("update", proof.scheduleRefresh);
  const stopSourceHydration = provider.subscribeHydration((hydrated) => {
    if (!hydrated) return;
    refreshTitle(editor);
    proof.scheduleRefresh();
  });
  const stopSourceSaveStatus = provider.subscribeSaveStatus((status) => {
    if (status === "saved") {
      proof.scheduleRefresh();
      docSidebar.scheduleRefresh();
    }
  });
  editor.on("destroy", stopSourceHydration);
  editor.on("destroy", stopSourceSaveStatus);
  awareness.on("change", renderPeers);
  refreshTitle(editor);
  activeAgents.clear();
  renderPeers();
  rememberOpenDocument(docId);
  void refreshProvenance();
  return true;
}

/**
 * Re-ask the daemon who wrote what.
 *
 * Attribution lives in the op log, not the CRDT (AD-1), so it does not ride the
 * update frames — it is fetched. Debounced because a burst of keystrokes is one
 * question, not forty, and the answer only moves once the daemon has committed.
 */
const PROVENANCE_DEBOUNCE_MS = 400;
let provenanceTimer: number | null = null;

async function refreshProvenance() {
  if (!open) return;
  const docId = openDocId;
  try {
    const blocks = await mcp.blockProvenance(docId);
    // The switcher may have moved on while this was in flight.
    if (open && openDocId === docId) open.rails.setProvenance(blocks);
  } catch (error) {
    // The rails keep saying whatever they last knew, but silence here is how a
    // stale margin looks exactly like an accurate one.
    notify(`Could not load authorship: ${reason(error)}`, "error");
  }
}

function scheduleProvenance() {
  if (provenanceTimer !== null) clearTimeout(provenanceTimer);
  provenanceTimer = window.setTimeout(() => void refreshProvenance(), PROVENANCE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------- presence

function ago(timestamp: number): string {
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ---------------------------------------------------------------- switcher

let results: DocumentSummary[] = [];
let selected = 0;
/** The switcher shows either live documents or the trash. */
let trashMode = false;

function renderHint() {
  els.hint.innerHTML = trashMode
    ? `<kbd>↵</kbd> open · <kbd>${ACCEL_LABEL}⌫</kbd> restore · <kbd>${ACCEL_LABEL}⇧⌫</kbd> back · <kbd>esc</kbd> close`
    : `<kbd>↵</kbd> open · <kbd>${ACCEL_LABEL}↵</kbd> new · <kbd>${ACCEL_LABEL}⌫</kbd> trash · <kbd>${ACCEL_LABEL}⇧⌫</kbd> view trash · <kbd>esc</kbd> close`;
  els.switcher.dataset.mode = trashMode ? "trash" : "live";
  els.input.placeholder = trashMode ? "Search the trash…" : "Search documents…";
}

function renderResults() {
  els.results.replaceChildren(
    ...results.map((row, i) => {
      const item = document.createElement("li");
      item.className = i === selected ? "hit selected" : "hit";
      item.textContent = row.title || "Untitled";
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
      return item;
    }),
  );
  if (results.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = trashMode
      ? "The trash is empty"
      : els.input.value
        ? `No matches — ${ACCEL_LABEL}↵ to create`
        : `No documents yet — ${ACCEL_LABEL}↵ to create`;
    els.results.replaceChildren(empty);
  }
}

async function refreshResults() {
  const query = els.input.value.trim();
  if (trashMode) {
    // Search runs over live documents only, so the trash filters by title.
    const all = await mcp.listDocuments(200, true);
    const needle = query.toLowerCase();
    results = needle
      ? all.filter((d) => d.title.toLowerCase().includes(needle))
      : all;
    selected = 0;
    renderResults();
    return;
  }
  if (query) {
    const hits = await mcp.search(query);
    results = hits.map((h) => ({ doc_id: h.doc_id, title: h.title, updated_at: 0 }));
  } else {
    results = await mcp.listDocuments();
  }
  selected = 0;
  renderResults();
}

function openSwitcher() {
  trashMode = false;
  renderHint();
  els.scrim.hidden = false;
  els.input.value = "";
  els.input.focus();
  void refreshResults();
}

function closeSwitcher() {
  els.scrim.hidden = true;
  open?.editor.commands.focus();
}

async function choose(index: number) {
  const row = results[index];
  if (!row) return;
  if (await openDocument(row.doc_id)) closeSwitcher();
}

async function toggleTrashMode() {
  trashMode = !trashMode;
  renderHint();
  els.input.value = "";
  els.input.focus();
  await refreshResults();
}

/**
 * Move one document to the trash. Soft: the document and its history remain,
 * and the tombstone replicates. If this window was showing it, move on to the
 * most recent remaining document rather than stare at a trashed one.
 */
async function trashDocument(row: { doc_id: string; title: string }): Promise<boolean> {
  const wasOpen = row.doc_id === openDocId;
  if (wasOpen && !(await canLeaveCurrentDocument())) return false;
  try {
    await editorApi.setDocumentDeleted(row.doc_id, true);
    notify(`Moved "${row.title || "Untitled"}" to the trash · ${ACCEL_LABEL}⇧⌫ to find it`);
    void docSidebar.refresh();
  } catch (error) {
    notify(`Could not trash: ${reason(error)}`, "error");
    return false;
  }
  if (wasOpen) {
    // Never leave the window on a trashed note: move to the most recent one
    // left, or to a fresh blank note when this was the last, as on first launch.
    const next = (await mcp.listDocuments()).find((document) => document.doc_id !== row.doc_id);
    closeSwitcher();
    await openDocument(next?.doc_id ?? (await editorApi.createDocument("")).doc_id);
    void docSidebar.refresh();
  }
  return true;
}

async function openInNewWindow(docId: string) {
  try {
    await invoke("new_window", { docId });
  } catch (error) {
    notify(`Could not open a new window: ${reason(error)}`, "error");
  }
}

/** The native context menu for a document in the sidebar. */
async function showDocumentMenu(row: { doc_id: string; title: string }) {
  const menu = await Menu.new({
    items: [
      { id: "open", text: "Open", action: () => void openDocument(row.doc_id) },
      {
        id: "open-window",
        text: "Open in New Window",
        action: () => void openInNewWindow(row.doc_id),
      },
      { item: "Separator" },
      { id: "trash", text: "Move to Trash", action: () => void trashDocument(row) },
    ],
  });
  await menu.popup();
}

/**
 * Trash the highlighted document. Soft: the document and its history remain,
 * and the tombstone replicates, so this is undoable by anyone with the id.
 */
async function trashSelected() {
  const row = results[selected];
  if (!row) return;

  // In the trash the same key means the opposite thing: put it back.
  if (trashMode) {
    try {
      await editorApi.setDocumentDeleted(row.doc_id, false);
      notify(`Restored "${row.title || "Untitled"}"`);
      void docSidebar.refresh();
      await refreshResults();
    } catch (error) {
      notify(`Could not restore: ${reason(error)}`, "error");
    }
    return;
  }

  if (await trashDocument(row)) await refreshResults();
}

/** Create a document and show it in this window, as Notes does. */
async function createDocumentHere(title: string) {
  if (!(await canLeaveCurrentDocument())) return;
  try {
    const created = await editorApi.createDocument(title);
    els.scrim.hidden = true;
    await openDocument(created.doc_id);
    void docSidebar.refresh();
  } catch (error) {
    notify(`Could not create document: ${reason(error)}`, "error");
  }
}

async function createNewDocument() {
  await createDocumentHere("");
}

async function createFromQuery() {
  await createDocumentHere(els.input.value.trim());
}

/** Show an imported or newly created document here and list it. */
async function showDocumentHere(docId: string): Promise<void> {
  await openDocument(docId);
  void docSidebar.refresh();
}

async function importMarkdownFile() {
  els.scrim.hidden = true;
  try {
    const file = await importMarkdownDocument(
      nativeFileBridge,
      editorApi,
      showDocumentHere,
    );
    if (file) notify(`Imported “${file.file_name}” as a new document`);
  } catch (error) {
    notify(`Could not import Markdown: ${reason(error)}`, "error");
  }
}

async function exportMarkdownFile(target = open): Promise<boolean> {
  if (!target) return false;
  try {
    // The live editor tree is the exact visible state. Exporting through it
    // also keeps the native file command independent from daemon transport.
    const exported = await exportMarkdownDocument(
      nativeFileBridge,
      editorSnapshot(target.editor),
      deriveTitle(target.editor),
    );
    if (!exported) return false;
    notify(`Exported “${exported.file_name}”`);
    return true;
  } catch (error) {
    notify(`Could not export Markdown: ${reason(error)}`, "error");
    return false;
  }
}

/**
 * Native windows are document-scoped. Browser development has no window API,
 * so it deliberately falls back to replacing the one preview editor.
 */
// ---------------------------------------------------------------- keys

// A file dropped anywhere but the chat composer must not make the web view
// navigate to it; the composer handles its own drops first.
for (const type of ["dragover", "drop"] as const) {
  document.addEventListener(type, (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
}

// File → New Note (⌘N) and New Window (⇧⌘N), and View → Zoom, are native
// menu items; the menu hands them to the focused window, which knows which
// note it shows.
if (isTauri()) {
  void getCurrentWebviewWindow().listen<string>("menu-action", ({ payload }) => {
    if (payload === "new-note") void createNewDocument();
    else if (payload === "new-window" && openDocId) void openInNewWindow(openDocId);
    else if (payload === "zoom-in" || payload === "zoom-out" || payload === "zoom-reset") {
      const command: ZoomCommand = payload === "zoom-in" ? "in" : payload === "zoom-out" ? "out" : "reset";
      window.dispatchEvent(new CustomEvent(ZOOM_COMMAND_EVENT, { detail: command }));
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (
    accel(event) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "o"
  ) {
    event.preventDefault();
    void importMarkdownFile();
    return;
  }
  if (
    accel(event) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    void exportMarkdownFile();
    return;
  }
  // Shift+accelerator+K belongs to the link editor. Keeping this exact avoids
  // the document switcher swallowing the more specific formatting shortcut.
  if (accel(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    els.scrim.hidden ? openSwitcher() : closeSwitcher();
    return;
  }
  if (els.scrim.hidden) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeSwitcher();
  } else if (event.key === "Backspace" && accel(event) && event.shiftKey) {
    event.preventDefault();
    void toggleTrashMode();
  } else if (event.key === "Backspace" && accel(event)) {
    event.preventDefault();
    void trashSelected();
  } else if (event.key === "Enter" && accel(event)) {
    event.preventDefault();
    void createFromQuery();
  } else if (event.key === "Enter") {
    event.preventDefault();
    choose(selected);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    selected = Math.max(0, Math.min(results.length - 1, selected + step));
    renderResults();
  }
});

els.input.addEventListener("input", () => void refreshResults());
els.scrim.addEventListener("mousedown", (e) => {
  if (e.target === els.scrim) closeSwitcher();
});

// ---------------------------------------------------------------- boot

/** Daemon capabilities cross only the verified native bootstrap boundary. */
async function loadConnection(): Promise<Connection> {
  if (!isTauri()) {
    throw new Error(
      "Open Proof of Thought through the native app; browser-only development is not supported.",
    );
  }
  return invoke<Connection>("connection");
}

async function boot() {
  relabelShortcutHints();
  connection = await loadConnection();
  mcp = new Mcp(connection.mcp_url, connection.token);
  editorApi = new EditorApi(connection.mcp_url, connection.token);
  await mcp.connect();

  const documents = await mcp.listDocuments();
  const requested = new URL(window.location.href).searchParams.get("doc");
  const last = lastOpenDocument();
  let targetId: string;
  if (requested) {
    // The list is intentionally paginated for the switcher. A native document
    // window is pinned to its query id, so validate that id directly instead
    // of silently falling back when it is outside the first page.
    targetId = (await mcp.readDocument(requested)).doc_id;
  } else {
    targetId =
      documents.find((document) => document.doc_id === last)?.doc_id ??
      documents[0]?.doc_id ??
      (await editorApi.createDocument("")).doc_id;
  }

  await openDocument(targetId);
  void docSidebar.refresh();
  if (requested) {
    // Keep the pin through all fallible startup work. A transient read or sync
    // failure must not turn Reload into a different document.
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  }
  await installNativeCloseGuard();
}

async function installNativeCloseGuard(): Promise<void> {
  const target = nativeWindow();
  if (!target) return;
  await target.onCloseRequested(async (event) => {
    const provider = open?.provider;
    if (!provider?.hasPendingChanges) return;

    // Native close requests are cancellable only synchronously. Keep the
    // window alive until the daemon confirms that SQLite has the latest edit.
    event.preventDefault();
    if (closingAfterAutosave) return;
    closingAfterAutosave = true;
    try {
      const saved = await provider.waitUntilSaved();
      if (!saved || open?.provider !== provider || provider.hasPendingChanges) {
        notify(
          "Window kept open because changes are still waiting to autosave.",
          "error",
        );
        return;
      }

      // `destroy` skips a second close-request event after the durability
      // barrier has passed.
      await target.destroy();
    } catch (error) {
      notify(`Could not close window: ${reason(error)}`, "error");
    } finally {
      closingAfterAutosave = false;
    }
  });
}

window.addEventListener("beforeunload", (event) => {
  if (!open?.provider.hasPendingChanges) return;
  event.preventDefault();
});

boot().catch((error) => {
  document.title = "Could not reach the daemon";
  notify(`Could not reach the daemon: ${reason(error)}`, "error");
  console.error(error);
});
