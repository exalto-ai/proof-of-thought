import type {
  ChatAttachment,
  ChatEdit,
  ChatMessage,
  ProChatBridge,
  ProviderModel,
  SendChatResponse,
  ThinkingLevel,
} from "./pro-chat-bridge";
import type { ChatChange, ChatSuggestionInput } from "./editor-api";
import type { ProProvider } from "./pro-provider-bridge";
import type { SuggestionPosition } from "./suggestions";
import { required } from "./dom";
import { oneLine } from "./notices";

/** Menu sections: whose account or key a model runs on. */
const SECTION_NAMES: Record<ProProvider, string> = {
  chatgpt: "ChatGPT Plan",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
};
const CONFIGURE_PROVIDERS = "configure";
const PROVIDER_NAMES: Record<ProProvider, string> = {
  chatgpt: "ChatGPT",
  openai: "OpenAI",
  anthropic: "Anthropic",
};
const MAX_ATTACHMENTS = 5;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PERSISTED_MESSAGES = 30;
const MAX_PERSISTED_RECORD_BYTES = 640 * 1024;
const MAX_PERSISTED_USER_MESSAGE_BYTES = 16 * 1024;
const MAX_PERSISTED_ASSISTANT_MESSAGE_BYTES = 64 * 1024;
const MAX_PERSISTED_IDENTIFIER_BYTES = 512;
const MAX_SUGGESTION_METADATA_BYTES = 160;
const MAX_SUGGESTION_REQUEST_ID_BYTES = 128;
const MAX_CHANGES = 20;
const MAX_PREVIEW_CHARS = 60;
const STORAGE_PREFIX = "thought.pro-chat.v1.";
const STORAGE_VERSION = 1;
const TEXT_FILE_NAME = /\.(?:csv|html?|json|log|markdown|md|toml|txt|xml|ya?ml)$/i;
const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/toml",
  "application/xml",
  "application/yaml",
]);

export type ProChatDocument = {
  id: string;
  title: string;
  snapshot(): unknown;
  /** Each top-level block's id, in the snapshot's order; null if not saved yet. */
  blockIds(): Array<string | null>;
  waitUntilSaved(): Promise<boolean>;
  selectedText(): string | null;
};

type ChatStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Options = {
  bridge?: ProChatBridge | null;
  /** Turn one chat edit into a suggestion in the note. */
  suggestEdit?: (input: ChatSuggestionInput) => Promise<{ suggestion: { suggestion_id: string } }>;
  /** Show a suggestion in the note and open its card. */
  focusSuggestion?: (suggestionId: string) => void;
  createRequestId?: () => string;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  storage?: ChatStorage | null;
  /** Open Settings → Chat, from the menu's Configure Providers… item. */
  openSettings?: () => void;
  /** After the selected provider changes, e.g. to show "Using ChatGPT plan". */
  onSelectionChange?: (provider: ProProvider | null) => void;
};

/** A suggestion a reply made in the note, as the chat links to it. */
type ChangeSummary = {
  suggestion_id: string;
  kind: ChatEdit["kind"];
  preview: string;
};

type LocalMessage = ChatMessage & {
  meta?: string;
  incomplete?: boolean;
  response?: SendChatResponse;
  thinking?: ThinkingLevel;
  attachments?: AttachmentSummary[];
  suggestionRequestId?: string;
  changes?: ChangeSummary[];
};

type PersistedResponse = Omit<SendChatResponse, "text" | "edits">;

type PersistedMessage = ChatMessage & {
  response?: PersistedResponse;
  thinking?: ThinkingLevel;
  attachments?: AttachmentSummary[];
  suggestionRequestId?: string;
  changes?: ChangeSummary[];
};

type PersistedConversation = {
  version: typeof STORAGE_VERSION;
  provider: ProProvider | null;
  model: string;
  thinking: ThinkingLevel;
  messages: PersistedMessage[];
};

type RestoredConversation = Omit<PersistedConversation, "messages"> & {
  messages: LocalMessage[];
};

type StagedAttachment = ChatAttachment & { sizeBytes: number };
type AttachmentSummary = {
  name: string;
  media_type: ChatAttachment["media_type"];
  size_bytes: number;
};

export type ProChatController = {
  setActive(active: boolean): void;
  /** The providers with a key or sign-in, in menu order. */
  setProviders(providers: readonly ProProvider[]): void;
  setDocument(document: ProChatDocument | null): void;
  destroy(): void;
};

function provider(value: unknown): ProProvider | null {
  return value === "chatgpt" || value === "openai" || value === "anthropic" ? value : null;
}

function thinkingLevel(value: unknown): ThinkingLevel | null {
  return value === "provider_default" || value === "low" || value === "medium" ||
      value === "high"
    ? value
    : null;
}

function thinking(value: unknown): ThinkingLevel {
  return thinkingLevel(value) ?? "provider_default";
}

function thinkingLabel(value: ThinkingLevel): string {
  switch (value) {
    case "provider_default":
      return "Provider default";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withinBytes(value: unknown, maximum: number): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximum;
}

function storedString(value: unknown, maximum: number): value is string {
  return withinBytes(value, maximum) && value.trim().length > 0 && !value.includes("\0");
}

function validSuggestionRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_SUGGESTION_REQUEST_ID_BYTES &&
    /^[A-Za-z0-9._-]+$/.test(value);
}

function validSuggestionMetadata(value: unknown): value is string {
  return storedString(value, MAX_SUGGESTION_METADATA_BYTES) &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function response(value: unknown, text: string): SendChatResponse | undefined {
  if (!isRecord(value)) return undefined;
  const responseProvider = provider(value.provider);
  if (
    responseProvider === null ||
    !validSuggestionMetadata(value.requested_model) ||
    !(value.reported_model === null ||
      validSuggestionMetadata(value.reported_model)) ||
    !validSuggestionMetadata(value.wording_revision) ||
    typeof value.complete !== "boolean"
  ) return undefined;
  return {
    text,
    edits: [],
    provider: responseProvider,
    requested_model: value.requested_model,
    reported_model: value.reported_model,
    wording_revision: value.wording_revision,
    complete: value.complete,
  };
}

function changeSummary(value: unknown): ChangeSummary | null {
  if (
    !isRecord(value) || !storedString(value.suggestion_id, MAX_PERSISTED_IDENTIFIER_BYTES) ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value.suggestion_id) ||
    (value.kind !== "replace_block" && value.kind !== "insert_blocks" &&
      value.kind !== "delete_block") ||
    typeof value.preview !== "string" || value.preview.length > MAX_PREVIEW_CHARS + 1
  ) return null;
  return { suggestion_id: value.suggestion_id, kind: value.kind, preview: value.preview };
}

/** The first line of some Markdown as plain words, shortened for a link. */
function preview(markdown: string): string {
  const line = markdown.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const plain = line.replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, "")
    .replace(/[*_`~]/g, "");
  return plain.length > MAX_PREVIEW_CHARS ? `${plain.slice(0, MAX_PREVIEW_CHARS).trimEnd()}…` : plain;
}

const CHANGE_VERBS: Record<ChatEdit["kind"], string> = {
  replace_block: "Edit",
  insert_blocks: "Add",
  delete_block: "Delete",
};

/**
 * A chat edit addressed by block index, readdressed by block id. A block the
 * CRDT does not hold yet (the trailing empty paragraph of a new note) is
 * replaced by inserting after the last block it does hold.
 */
function chatChange(edit: ChatEdit, ids: Array<string | null>): ChatChange | null {
  const after = (index: number): SuggestionPosition => {
    for (let at = index; at >= 0; at--) {
      const id = ids[at];
      if (id) return { kind: "block", block_id: id };
    }
    return { kind: "start" };
  };
  switch (edit.kind) {
    case "insert_blocks":
      return {
        kind: "insert_blocks",
        after: edit.after.kind === "block" ? after(edit.after.block) : edit.after,
        markdown: edit.markdown,
      };
    case "replace_block": {
      const id = ids[edit.block];
      return id
        ? { kind: "replace_block", block_id: id, markdown: edit.markdown, original: edit.original }
        : { kind: "insert_blocks", after: after(edit.block - 1), markdown: edit.markdown };
    }
    case "delete_block": {
      const id = ids[edit.block];
      return id ? { kind: "delete_block", block_id: id, original: edit.original } : null;
    }
  }
}

function attachmentSummary(value: unknown): AttachmentSummary | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  let name: string;
  try {
    name = attachmentName(value.name);
  } catch {
    return null;
  }
  if (
    (value.media_type !== "application/pdf" && value.media_type !== "text/plain") ||
    typeof value.size_bytes !== "number" || !Number.isSafeInteger(value.size_bytes) ||
    value.size_bytes <= 0
  ) return null;
  const maximum = value.media_type === "application/pdf" ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
  if (value.size_bytes > maximum) return null;
  return { name, media_type: value.media_type, size_bytes: value.size_bytes };
}

function localMessage(value: unknown): LocalMessage | null {
  if (
    !isRecord(value) || (value.role !== "user" && value.role !== "assistant") ||
    !storedString(
      value.text,
      value.role === "user"
        ? MAX_PERSISTED_USER_MESSAGE_BYTES
        : MAX_PERSISTED_ASSISTANT_MESSAGE_BYTES,
    )
  ) return null;
  const savedResponse = response(value.response, value.text);
  if (value.response !== undefined && savedResponse === undefined) return null;
  const suggestionRequestId = validSuggestionRequestId(value.suggestionRequestId)
    ? value.suggestionRequestId
    : undefined;
  if (value.suggestionRequestId !== undefined && suggestionRequestId === undefined) return null;
  // Written by the old Add to Note button; nothing reads it now.
  if (value.suggested !== undefined && value.suggested !== true) return null;
  if (value.changes !== undefined && !Array.isArray(value.changes)) return null;
  const changes = Array.isArray(value.changes) ? value.changes.map(changeSummary) : [];
  if (changes.length > MAX_CHANGES || changes.some((change) => change === null)) return null;
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) return null;
  const attachments = Array.isArray(value.attachments)
    ? value.attachments.map(attachmentSummary)
    : [];
  if (
    attachments.length > MAX_ATTACHMENTS || attachments.some((attachment) => attachment === null)
  ) return null;
  const attachmentValues = attachments as AttachmentSummary[];
  if (
    new Set(attachmentValues.map(({ name }) => name)).size !== attachmentValues.length ||
    attachmentValues.reduce((sum, attachment) => sum + attachment.size_bytes, 0) >
      MAX_TOTAL_ATTACHMENT_BYTES ||
    (value.role === "assistant" && savedResponse === undefined) ||
    (savedResponse !== undefined && value.role !== "assistant") ||
    (attachmentValues.length > 0 && value.role !== "user")
  ) return null;
  const requestedThinking = savedResponse ? thinkingLevel(value.thinking) : null;
  if (savedResponse && requestedThinking === null) return null;
  if (savedResponse && suggestionRequestId === undefined) return null;
  const hasAssistantOnlyState = value.response !== undefined || value.thinking !== undefined ||
    value.suggestionRequestId !== undefined || value.suggested !== undefined ||
    changes.length > 0;
  if (
    (value.role !== "assistant" && hasAssistantOnlyState) ||
    (value.role === "assistant" && attachmentValues.length > 0) ||
    (value.role === "assistant" && hasAssistantOnlyState && savedResponse === undefined) ||
    (value.suggested === true && suggestionRequestId === undefined)
  ) return null;
  const reportedModel = savedResponse?.reported_model ?? savedResponse?.requested_model;
  const thinkingCopy = requestedThinking
    ? `${thinkingLabel(requestedThinking)} thinking requested`
    : null;
  return {
    role: value.role,
    text: value.text,
    response: savedResponse,
    thinking: requestedThinking ?? undefined,
    attachments: attachmentValues.length > 0 ? attachmentValues : undefined,
    suggestionRequestId,
    changes: changes.length > 0 ? changes as ChangeSummary[] : undefined,
    meta: savedResponse
      ? [PROVIDER_NAMES[savedResponse.provider], reportedModel, thinkingCopy]
        .filter(Boolean).join(" · ")
      : undefined,
    incomplete: savedResponse ? !savedResponse.complete : undefined,
  };
}

function persistedConversation(value: unknown): RestoredConversation | null {
  if (
    !isRecord(value) || value.version !== STORAGE_VERSION ||
    !Array.isArray(value.messages) || value.messages.length > MAX_PERSISTED_MESSAGES ||
    !withinBytes(value.model, MAX_PERSISTED_IDENTIFIER_BYTES) || value.model.includes("\0") ||
    thinkingLevel(value.thinking) === null
  ) return null;
  const savedProvider = value.provider === null ? null : provider(value.provider);
  if (value.provider !== null && savedProvider === null) return null;
  if (
    (savedProvider === null && value.model !== "") ||
    (savedProvider !== null && !storedString(value.model, MAX_PERSISTED_IDENTIFIER_BYTES))
  ) return null;
  const savedMessages = value.messages.map(localMessage);
  if (savedMessages.some((message) => message === null)) return null;
  if (savedMessages.length % 2 !== 0) return null;
  if (savedMessages.some((message, index) =>
    message?.role !== (index % 2 === 0 ? "user" : "assistant"))) return null;
  return {
    version: STORAGE_VERSION,
    provider: savedProvider,
    model: value.model,
    thinking: value.thinking as ThinkingLevel,
    messages: savedMessages as LocalMessage[],
  };
}

function persistedMessage(message: LocalMessage): PersistedMessage {
  const saved: PersistedMessage = { role: message.role, text: message.text };
  if (message.response) {
    saved.response = {
      provider: message.response.provider,
      requested_model: message.response.requested_model,
      reported_model: message.response.reported_model,
      wording_revision: message.response.wording_revision,
      complete: message.response.complete,
    };
    saved.thinking = message.thinking ?? "provider_default";
  }
  if (message.attachments?.length) {
    saved.attachments = message.attachments.map((attachment) => ({ ...attachment }));
  }
  if (message.suggestionRequestId) saved.suggestionRequestId = message.suggestionRequestId;
  if (message.changes?.length) saved.changes = message.changes.map((change) => ({ ...change }));
  return saved;
}

function storageKey(documentId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(documentId)}`;
}

function attachmentMediaType(
  file: File,
  name: string,
): ChatAttachment["media_type"] | null {
  const mediaType = file.type.toLowerCase();
  if (mediaType === "application/pdf" || name.toLowerCase().endsWith(".pdf")) {
    return "application/pdf";
  }
  if (
    mediaType.startsWith("text/") || TEXT_MEDIA_TYPES.has(mediaType) ||
    TEXT_FILE_NAME.test(name)
  ) return "text/plain";
  return null;
}

function attachmentName(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed || trimmed === "." || trimmed === ".." ||
    /[\\/\u0000-\u001f\u007f]/.test(trimmed) ||
    new TextEncoder().encode(trimmed).byteLength > 200
  ) {
    throw new Error(
      "Attachment names must be 200 UTF-8 bytes or fewer and cannot contain paths or control characters.",
    );
  }
  return trimmed;
}

function displayFileName(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 80) || "This file";
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export function installProChat(
  root: Document,
  options: Options = {},
): ProChatController {
  const panel = required<HTMLElement>(root, "#pro-chat", "chat");
  const modelSelect = required<HTMLSelectElement>(panel, "#pro-chat-model", "chat");
  const thinkingSelect = required<HTMLSelectElement>(panel, "#pro-chat-thinking", "chat");
  const retry = required<HTMLButtonElement>(panel, "#pro-chat-retry", "chat");
  const storageNotice = required<HTMLElement>(panel, "#pro-chat-storage-notice", "chat");
  const documentLabel = required<HTMLElement>(panel, "#pro-chat-document", "chat");
  const messagesElement = required<HTMLOListElement>(panel, "#pro-chat-messages", "chat");
  const empty = required<HTMLElement>(panel, "#pro-chat-empty", "chat");
  const error = required<HTMLElement>(panel, "#pro-chat-error", "chat");
  const form = required<HTMLFormElement>(panel, "#pro-chat-form", "chat");
  const input = required<HTMLTextAreaElement>(panel, "#pro-chat-input", "chat");
  const send = required<HTMLButtonElement>(panel, "#pro-chat-send", "chat");
  // Optional: the window does not offer New chat for now.
  const newChat = panel.querySelector<HTMLButtonElement>("#pro-chat-new");
  const attach = required<HTMLButtonElement>(panel, "#pro-chat-attach", "chat");
  const attachmentInput = required<HTMLInputElement>(panel, "#pro-chat-attachment-input", "chat");
  const attachmentList = required<HTMLUListElement>(panel, "#pro-chat-attachments", "chat");
  const bridge = options.bridge ?? null;
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  const disposers: Array<() => void> = [];
  let currentDocument: ProChatDocument | null = null;
  let messages: LocalMessage[] = [];
  let stagedAttachments: StagedAttachment[] = [];
  let pendingText: string | null = null;
  let providers: ProProvider[] = [];
  /** Model lists per configured provider, loaded once per session. */
  const catalog = new Map<ProProvider, ProviderModel[]>();
  let selectedProvider: ProProvider | null = null;
  let selectedModel = "";
  let modelGeneration = 0;
  let active = false;
  let loadingModels = false;
  let readingAttachments = false;
  let destroyed = false;
  let requestGeneration = 0;
  let attachmentGeneration = 0;
  let storageNoticeShown = false;
  let storage: ChatStorage | null = null;
  let storageAccessFailed = false;

  try {
    storage = options.storage === undefined ? window.localStorage : options.storage;
  } catch {
    storageAccessFailed = true;
  }

  function listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    event: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ) {
    target.addEventListener(event, listener);
    disposers.push(() => target.removeEventListener(event, listener));
  }

  function setError(message: string | null): void {
    error.textContent = message ?? "";
    error.hidden = message === null;
  }

  function showStorageNotice(): void {
    if (storageNoticeShown) return;
    storageNoticeShown = true;
    storageNotice.textContent =
      "Saved chat is unavailable. This chat will continue in this window.";
    storageNotice.hidden = false;
  }

  if (storageAccessFailed || storage === null) showStorageNotice();

  function discardStoredConversation(documentId: string): void {
    if (storage === null) return;
    try {
      storage.removeItem(storageKey(documentId));
    } catch {
      // The single storage notice below covers both the original failure and
      // a best-effort cleanup failure. Live chat remains available.
    }
  }

  function readConversation(documentId: string): RestoredConversation | null {
    if (storage === null) return null;
    try {
      const raw = storage.getItem(storageKey(documentId));
      if (raw === null) return null;
      if (new TextEncoder().encode(raw).byteLength > MAX_PERSISTED_RECORD_BYTES) {
        discardStoredConversation(documentId);
        showStorageNotice();
        return null;
      }
      const saved = persistedConversation(JSON.parse(raw));
      if (saved === null) {
        discardStoredConversation(documentId);
        showStorageNotice();
      }
      return saved;
    } catch {
      discardStoredConversation(documentId);
      showStorageNotice();
      return null;
    }
  }

  function saveConversation(): void {
    if (storage === null || currentDocument === null) return;
    const saved: PersistedConversation = {
      version: STORAGE_VERSION,
      provider: selectedProvider,
      model: selectedModel,
      thinking: thinking(thinkingSelect.value),
      messages: messages.map(persistedMessage),
    };
    try {
      const serialized = JSON.stringify(saved);
      if (
        persistedConversation(saved) === null ||
        new TextEncoder().encode(serialized).byteLength > MAX_PERSISTED_RECORD_BYTES
      ) {
        showStorageNotice();
        return;
      }
      storage.setItem(storageKey(currentDocument.id), serialized);
    } catch {
      showStorageNotice();
    }
  }

  function clearSavedConversation(): void {
    if (storage === null || currentDocument === null) return;
    try {
      storage.removeItem(storageKey(currentDocument.id));
    } catch {
      showStorageNotice();
    }
  }

  function messageElement(message: LocalMessage, pending = false): HTMLLIElement {
    const item = root.createElement("li");
    item.dataset.role = message.role;
    if (pending) item.dataset.pending = "true";
    const label = root.createElement("strong");
    label.textContent = message.role === "user" ? "You" : "Assistant";
    const text = root.createElement("p");
    text.textContent = message.text;
    item.append(label, text);
    if (message.attachments?.length) {
      const attachments = root.createElement("small");
      attachments.className = "pro-chat-message-attachments";
      attachments.textContent = `Attached: ${message.attachments.map((attachment) =>
        `${attachment.name} (${fileSize(attachment.size_bytes)})`).join(", ")}`;
      item.append(attachments);
    }
    // Which provider and model answered is kept for attribution, but quietly:
    // a tooltip and screen-reader text rather than a line under every reply.
    if (message.meta) {
      item.title = message.meta;
      const meta = root.createElement("small");
      meta.className = "sr-only";
      meta.textContent = message.meta;
      item.append(meta);
    }
    if (message.incomplete) {
      const incomplete = root.createElement("small");
      incomplete.textContent = "Provider marked this response incomplete";
      item.append(incomplete);
    }
    if (message.changes?.length) {
      const changes = root.createElement("div");
      changes.className = "pro-chat-changes";
      for (const change of message.changes) {
        const link = root.createElement("button");
        link.type = "button";
        link.className = "pro-chat-change";
        link.dataset.kind = change.kind;
        link.textContent = change.preview
          ? `${CHANGE_VERBS[change.kind]}: ${change.preview}`
          : CHANGE_VERBS[change.kind];
        link.title = "Show this suggestion in the note";
        link.addEventListener("click", () => options.focusSuggestion?.(change.suggestion_id));
        changes.append(link);
      }
      item.append(changes);
    }
    return item;
  }

  function renderMessages(): void {
    const rendered = messages.map((message) => messageElement(message));
    if (pendingText !== null) {
      rendered.push(messageElement({ role: "user", text: pendingText }, true));
    }
    messagesElement.replaceChildren(...rendered);
    messagesElement.hidden = rendered.length === 0;
    empty.hidden = rendered.length !== 0;
    if (newChat) newChat.hidden = messages.length === 0 && pendingText === null;
    if (newChat) newChat.disabled = loadingModels || pendingText !== null ||
      readingAttachments;
  }

  function removeAttachment(index: number): void {
    stagedAttachments.splice(index, 1);
    attachmentInput.value = "";
    setError(null);
    render();
  }

  function renderAttachments(): void {
    const busy = pendingText !== null || readingAttachments;
    const items = stagedAttachments.map((attachment, index) => {
      const item = root.createElement("li");
      const name = root.createElement("span");
      name.textContent = `${attachment.name} · ${fileSize(attachment.sizeBytes)}`;
      name.title = attachment.name;
      const remove = root.createElement("button");
      remove.type = "button";
      remove.className = "text-button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${attachment.name}`);
      remove.disabled = busy;
      remove.addEventListener("click", () => removeAttachment(index));
      item.append(name, remove);
      return item;
    });
    attachmentList.replaceChildren(...items);
    attachmentList.hidden = items.length === 0;
  }

  function renderControls(): void {
    const hasModel = selectedModel !== "";
    const busy = pendingText !== null || readingAttachments;
    documentLabel.textContent = currentDocument
      ? `Current document: ${currentDocument.title}`
      : "Open a document to start a chat.";
    attach.disabled = currentDocument === null || selectedProvider === null || busy ||
      stagedAttachments.length >= MAX_ATTACHMENTS;
    attachmentInput.disabled = attach.disabled;
    modelSelect.disabled = busy;
    thinkingSelect.disabled = selectedProvider === null || !hasModel || loadingModels || busy;
    retry.disabled = loadingModels || selectedProvider === null || bridge === null || busy;
    input.disabled = currentDocument === null || busy || bridge === null;
    send.disabled = currentDocument === null || selectedProvider === null || !hasModel ||
      busy || input.value.trim() === "" || bridge === null;
    panel.setAttribute("aria-busy", String(loadingModels || busy));
    const sending = pendingText !== null;
    send.setAttribute("aria-label", sending ? "Sending…" : "Send");
    send.title = sending ? "Sending…" : "Send";
    send.dataset.pending = String(sending);
  }

  function render(): void {
    renderMessages();
    renderAttachments();
    renderMenu();
    renderControls();
  }

  function clearAttachments(): void {
    attachmentGeneration += 1;
    stagedAttachments = [];
    readingAttachments = false;
    attachmentInput.value = "";
  }

  function clearTransientState(): void {
    requestGeneration += 1;
    retry.hidden = true;
    pendingText = null;
    input.value = "";
    clearAttachments();
    setError(null);
  }

  function newConversation(): void {
    clearTransientState();
    messages = [];
    clearSavedConversation();
    render();
  }

  function selectionKey(): string {
    return selectedProvider && selectedModel ? `${selectedProvider}:${selectedModel}` : "";
  }

  /** One pop-up: a section per configured provider, then Configure Providers…. */
  function renderMenu(): void {
    const children: HTMLElement[] = [];
    for (const name of providers) {
      const models = catalog.get(name);
      if (!models) continue;
      const group = root.createElement("optgroup");
      group.label = SECTION_NAMES[name];
      for (const model of models) {
        const option = root.createElement("option");
        option.value = `${name}:${model.id}`;
        option.textContent = model.display_name;
        group.append(option);
      }
      children.push(group);
    }
    if (children.length === 0) {
      const placeholder = root.createElement("option");
      placeholder.value = "";
      placeholder.textContent = loadingModels ? "Loading models…" : "No models";
      placeholder.disabled = true;
      children.push(placeholder);
    }
    children.push(root.createElement("hr"));
    const configure = root.createElement("option");
    configure.value = CONFIGURE_PROVIDERS;
    configure.textContent = "Configure Providers…";
    children.push(configure);
    modelSelect.replaceChildren(...children);
    modelSelect.value = selectionKey();
  }

  /** Keep the selection on a model that exists, preferring the saved one. */
  function ensureSelection(): void {
    const before = selectedProvider;
    const models = selectedProvider ? catalog.get(selectedProvider) : undefined;
    if (models && models.some(({ id }) => id === selectedModel)) return;
    if (models?.length) {
      selectedModel = models[0].id;
    } else if (selectedProvider === null || !providers.includes(selectedProvider) ||
      catalog.size === providers.length) {
      const first = providers.find((name) => catalog.get(name)?.length);
      selectedProvider = first ?? null;
      selectedModel = first ? catalog.get(first)![0].id : "";
    }
    if (selectedProvider !== before) options.onSelectionChange?.(selectedProvider);
  }

  async function loadModels(): Promise<void> {
    // The catalog is shared across documents, so loads are not cancelled by a
    // document switch, and one is enough at a time.
    if (loadingModels) return;
    const generation = ++modelGeneration;
    retry.hidden = true;
    setError(null);
    const missing = providers.filter((name) => !catalog.has(name));
    if (bridge === null || !active || missing.length === 0) {
      loadingModels = false;
      ensureSelection();
      render();
      return;
    }
    loadingModels = true;
    render();
    const results = await Promise.allSettled(missing.map((name) => bridge.models(name)));
    if (destroyed || generation !== modelGeneration) return;
    let failure: unknown = null;
    results.forEach((result, index) => {
      const name = missing[index];
      if (result.status === "fulfilled" && result.value.provider === name && result.value.models.length) {
        catalog.set(name, result.value.models);
      } else {
        failure = result.status === "rejected"
          ? result.reason
          : new Error("The provider returned no usable models.");
      }
    });
    loadingModels = false;
    ensureSelection();
    if (failure !== null) {
      setError(oneLine(failure, "The provider request failed."));
      retry.hidden = false;
    }
    saveConversation();
    render();
    if (active && providers.some((name) => !catalog.has(name)) && failure === null) {
      void loadModels();
    }
  }

  async function stageFiles(files: readonly File[]): Promise<void> {
    const documentId = currentDocument?.id;
    const generation = ++attachmentGeneration;
    attachmentInput.value = "";
    if (documentId === undefined || files.length === 0) return;
    if (stagedAttachments.length + files.length > MAX_ATTACHMENTS) {
      setError("Attach no more than 5 files to one request.");
      render();
      return;
    }
    readingAttachments = true;
    setError(null);
    render();
    try {
      const next: StagedAttachment[] = [];
      let totalBytes = stagedAttachments.reduce((sum, file) => sum + file.sizeBytes, 0);
      const names = new Set(stagedAttachments.map(({ name }) => name));
      for (const file of files) {
        const name = attachmentName(file.name);
        if (names.has(name)) {
          throw new Error(`“${displayFileName(name)}” is already attached.`);
        }
        const mediaType = attachmentMediaType(file, name);
        if (mediaType === null) {
          throw new Error("Only PDF and UTF-8 text files can be attached.");
        }
        const maximum = mediaType === "application/pdf" ? MAX_PDF_BYTES : MAX_TEXT_BYTES;
        const limit = mediaType === "application/pdf" ? "10 MiB" : "512 KiB";
        if (file.size <= 0) {
          throw new Error(`“${displayFileName(name)}” is empty.`);
        }
        if (file.size > maximum) {
          throw new Error(`“${displayFileName(name)}” exceeds the ${limit} limit.`);
        }
        if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error("Attachments cannot exceed 20 MiB in total.");
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (
          destroyed || generation !== attachmentGeneration ||
          currentDocument?.id !== documentId
        ) return;
        if (bytes.byteLength > maximum) {
          throw new Error(`“${displayFileName(name)}” exceeds the ${limit} limit.`);
        }
        if (bytes.byteLength === 0) {
          throw new Error(`“${displayFileName(name)}” is empty.`);
        }
        if (totalBytes + bytes.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error("Attachments cannot exceed 20 MiB in total.");
        }
        if (mediaType === "application/pdf" && !isPdf(bytes)) {
          throw new Error(`“${displayFileName(name)}” is not a valid PDF file.`);
        }
        if (mediaType === "text/plain") {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (text.includes("\0")) throw new Error("null byte");
          } catch {
            throw new Error(`“${displayFileName(name)}” is not a UTF-8 text file.`);
          }
        }
        next.push({
          name,
          media_type: mediaType,
          content_base64: base64(bytes),
          sizeBytes: bytes.byteLength,
        });
        names.add(name);
        totalBytes += bytes.byteLength;
      }
      stagedAttachments.push(...next);
    } catch (cause) {
      if (
        !destroyed && generation === attachmentGeneration &&
        currentDocument?.id === documentId
      ) setError(oneLine(cause, "The provider request failed."));
    } finally {
      if (
        !destroyed && generation === attachmentGeneration &&
        currentDocument?.id === documentId
      ) {
        readingAttachments = false;
        render();
      }
    }
  }

  async function submit(): Promise<void> {
    const document = currentDocument;
    const message = input.value.trim();
    if (
      bridge === null || document === null || selectedProvider === null ||
      selectedModel === "" || pendingText !== null ||
      readingAttachments || !message
    ) return;
    if (messages.length >= MAX_PERSISTED_MESSAGES) {
      setError("This conversation is full. Start a new chat.");
      return;
    }
    if (
      message.includes("\0") ||
      new TextEncoder().encode(message).byteLength > MAX_PERSISTED_USER_MESSAGE_BYTES
    ) {
      setError("Messages must be valid text no larger than 16 KiB.");
      return;
    }

    const model = selectedModel;
    const selectedThinking = thinking(thinkingSelect.value);
    const snapshot = document.snapshot();
    const blockIds = document.blockIds();
    const generation = ++requestGeneration;
    const previous = messages.map(({ role, text }) => ({ role, text }));
    const requestAttachments: ChatAttachment[] = stagedAttachments.map((attachment) => ({
      name: attachment.name,
      media_type: attachment.media_type,
      content_base64: attachment.content_base64,
    }));
    const attachmentSummaries: AttachmentSummary[] = stagedAttachments.map((attachment) => ({
      name: attachment.name,
      media_type: attachment.media_type,
      size_bytes: attachment.sizeBytes,
    }));
    pendingText = message;
    input.value = "";
    setError(null);
    render();
    try {
      const chatResponse = await bridge.send({
        document_title: document.title,
        document: snapshot,
        provider: selectedProvider,
        model,
        thinking: selectedThinking,
        messages: previous,
        message,
        focus_text: null,
        attachments: requestAttachments,
        disclosure_version: 2,
      });
      if (destroyed || generation !== requestGeneration || currentDocument?.id !== document.id) {
        return;
      }
      // Validated by the native side; an older one sends no edits at all.
      chatResponse.edits = Array.isArray(chatResponse.edits) ? chatResponse.edits : [];
      if (!chatResponse.text.trim() && chatResponse.edits.length === 0) {
        throw new Error("The provider returned an empty reply.");
      }
      if (
        chatResponse.text.includes("\0") ||
        new TextEncoder().encode(chatResponse.text).byteLength >
          MAX_PERSISTED_ASSISTANT_MESSAGE_BYTES
      ) throw new Error("The provider returned a response that is too large to use safely.");
      const reportedModel = chatResponse.reported_model ?? chatResponse.requested_model;
      const thinkingCopy = `${thinkingLabel(selectedThinking)} thinking requested`;
      const suggestionRequestId = createRequestId();
      if (!validSuggestionRequestId(suggestionRequestId)) {
        throw new Error("Proof of Thought could not create a safe suggestion retry identifier.");
      }
      const changes = await suggestEdits(document, chatResponse, blockIds, suggestionRequestId);
      if (destroyed || generation !== requestGeneration || currentDocument?.id !== document.id) {
        return;
      }
      const text = chatResponse.text.trim()
        ? chatResponse.text
        : changes.length === 0
          ? "Could not suggest the edits."
          : changes.length === 1 ? "Suggested an edit." : `Suggested ${changes.length} edits.`;
      messages.push(
        {
          role: "user",
          text: message,
          attachments: attachmentSummaries.length > 0 ? attachmentSummaries : undefined,
        },
        {
          role: "assistant",
          text,
          meta: `${PROVIDER_NAMES[chatResponse.provider]} · ${reportedModel} · ${thinkingCopy}`,
          incomplete: !chatResponse.complete,
          response: chatResponse,
          thinking: selectedThinking,
          suggestionRequestId,
          changes: changes.length > 0 ? changes : undefined,
        },
      );
      clearAttachments();
      saveConversation();
    } catch (cause) {
      if (!destroyed && generation === requestGeneration) {
        input.value = message;
        setError(oneLine(cause, "The provider request failed."));
      }
    } finally {
      if (!destroyed && generation === requestGeneration) {
        pendingText = null;
        render();
      }
    }
  }

  /**
   * Turn a reply's edits into suggestions in the note, in order. Each edit
   * that fails is reported once; the rest still land.
   */
  async function suggestEdits(
    document: ProChatDocument,
    chatResponse: SendChatResponse,
    blockIds: Array<string | null>,
    requestId: string,
  ): Promise<ChangeSummary[]> {
    if (chatResponse.edits.length === 0 || options.suggestEdit === undefined) return [];
    if (!(await document.waitUntilSaved())) {
      throw new Error("Wait for this note to finish saving, then try again.");
    }
    const changes: ChangeSummary[] = [];
    const failures: string[] = [];
    for (const [index, edit] of chatResponse.edits.slice(0, MAX_CHANGES).entries()) {
      const change = chatChange(edit, blockIds);
      if (change === null) continue;
      try {
        const outcome = await options.suggestEdit({
          documentId: document.id,
          requestId: `${requestId}.${index}`,
          provider: chatResponse.provider,
          requestedModel: chatResponse.requested_model,
          reportedModel: chatResponse.reported_model,
          change,
        });
        changes.push({
          suggestion_id: outcome.suggestion.suggestion_id,
          kind: edit.kind,
          preview: preview(edit.kind === "delete_block" ? edit.original : edit.markdown),
        });
      } catch (cause) {
        failures.push(oneLine(cause, "The suggestion could not be created."));
      }
    }
    if (failures.length > 0) {
      const count = failures.length === 1 ? "an edit" : `${failures.length} edits`;
      setError(`Could not suggest ${count}: ${failures[0]}`);
    }
    return changes;
  }

  listen(modelSelect, "change", () => {
    if (modelSelect.value === CONFIGURE_PROVIDERS) {
      modelSelect.value = selectionKey();
      options.openSettings?.();
      return;
    }
    const separator = modelSelect.value.indexOf(":");
    const chosen = provider(modelSelect.value.slice(0, separator));
    if (separator < 0 || chosen === null) return;
    if (chosen !== selectedProvider) {
      // Attachment formats differ by provider; staged files do not carry over.
      clearAttachments();
      selectedProvider = chosen;
      options.onSelectionChange?.(chosen);
    }
    selectedModel = modelSelect.value.slice(separator + 1);
    saveConversation();
    render();
  });
  listen(thinkingSelect, "change", () => {
    thinkingSelect.value = thinking(thinkingSelect.value);
    saveConversation();
    renderControls();
  });
  listen(retry, "click", () => void loadModels());
  listen(input, "input", renderControls);
  // Return sends, as in chat apps; Shift-Return adds a line. An input method
  // still composing keeps Return for itself.
  listen(input, "keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!send.disabled) void submit();
  });
  listen(attach, "click", () => attachmentInput.click());
  // Drop files on the composer to attach them, as with the attach button.
  const composer = form.querySelector<HTMLElement>(".pro-chat-composer") ?? form;
  const carriesFiles = (event: DragEvent) =>
    event.dataTransfer?.types.includes("Files") === true && !attach.disabled;
  listen(composer, "dragover", (event) => {
    const drag = event as DragEvent;
    if (!carriesFiles(drag)) return;
    drag.preventDefault();
    if (drag.dataTransfer) drag.dataTransfer.dropEffect = "copy";
    composer.classList.add("is-drop-target");
  });
  listen(composer, "dragleave", (event) => {
    const related = (event as DragEvent).relatedTarget as Node | null;
    if (!related || !composer.contains(related)) composer.classList.remove("is-drop-target");
  });
  listen(composer, "drop", (event) => {
    const drag = event as DragEvent;
    composer.classList.remove("is-drop-target");
    if (!carriesFiles(drag)) return;
    drag.preventDefault();
    void stageFiles(Array.from(drag.dataTransfer?.files ?? []));
  });
  listen(attachmentInput, "change", () => {
    void stageFiles(Array.from(attachmentInput.files ?? []));
  });
  listen(form, "submit", (event) => {
    event.preventDefault();
    void submit();
  });
  if (newChat) listen(newChat, "click", newConversation);

  render();
  return {
    setActive(next) {
      const activated = !active && next;
      active = next;
      renderControls();
      if (activated && !loadingModels && providers.some((name) => !catalog.has(name))) {
        void loadModels();
      }
    },
    setProviders(next) {
      const changed = next.length !== providers.length || next.some((name, i) => providers[i] !== name);
      if (!changed) return;
      providers = [...next];
      for (const name of [...catalog.keys()]) {
        if (!providers.includes(name)) catalog.delete(name);
      }
      // A load in flight was for the old set; let the new set start afresh.
      modelGeneration += 1;
      loadingModels = false;
      ensureSelection();
      render();
      if (active) void loadModels();
    },
    setDocument(document) {
      const changed = currentDocument?.id !== document?.id;
      currentDocument = document;
      if (!changed) {
        renderControls();
        return;
      }
      clearTransientState();
      messages = [];
      thinkingSelect.value = "provider_default";
      const before = selectedProvider;
      if (document) {
        const saved = readConversation(document.id);
        if (saved) {
          selectedProvider = saved.provider;
          selectedModel = saved.model;
          thinkingSelect.value = saved.thinking;
          messages = saved.messages;
        }
      }
      ensureSelection();
      if (selectedProvider !== before) options.onSelectionChange?.(selectedProvider);
      render();
      if (active && providers.some((name) => !catalog.has(name))) void loadModels();
    },
    destroy() {
      destroyed = true;
      requestGeneration += 1;
      clearAttachments();
      disposers.splice(0).forEach((dispose) => dispose());
    },
  };
}
