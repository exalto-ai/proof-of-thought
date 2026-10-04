import type { Editor } from "@tiptap/core";
import { DOMSerializer, Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
import { ICONS, icon } from "./icons";
import { alignBlocks, blockIdOf } from "./provenance";
import { oneLine } from "./notices";

export type SuggestionPosition =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "block"; block_id: string };

export type SuggestionState = "pending" | "accepted" | "rejected" | "stale";

export type SuggestionNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: SuggestionNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export type SuggestionPatch =
  | { kind: "replace_block"; block_id: string; nodes: SuggestionNode[] }
  | { kind: "replace_text"; block_id: string; nodes: SuggestionNode[] }
  | {
    kind: "insert_blocks";
    after: { kind: "start" } | { kind: "end" } | { kind: "block"; block_id: string };
    nodes: SuggestionNode[];
  }
  | { kind: "delete_block"; block_id: string };

export type SuggestionRecord = {
  version: number;
  suggestion_id: string;
  document_id: string;
  request_id: string;
  proposer: {
    actor_id: string;
    connection_id: string;
    label: string;
    source_label: string;
    reported_model: string | null;
    session_id: string | null;
  };
  base_content_revision: string;
  patch: SuggestionPatch;
  explanation: string | null;
  state: SuggestionState;
  decision: { actor_id: string; actor_label: string; decided_at: number } | null;
  created_at: number;
};

export type SuggestionList = {
  content_revision: string;
  suggestions: SuggestionRecord[];
};

export type SuggestionDecisionOutcome = {
  content_revision: string;
  suggestion: SuggestionRecord;
};

export type SuggestionClient = {
  listSuggestions(documentId: string): Promise<SuggestionList>;
  acceptSuggestion(documentId: string, suggestionId: string): Promise<SuggestionDecisionOutcome>;
  rejectSuggestion(documentId: string, suggestionId: string): Promise<SuggestionDecisionOutcome>;
};

export type SuggestionReviewController = {
  refresh(): Promise<void>;
  /** Scroll to a suggestion and open its Accept/Reject popover. */
  focus(suggestionId: string): boolean;
  destroy(): void;
};

type BlockPosition = { node: ProseMirrorNode; from: number; to: number };
type DecisionKind = "accept" | "reject";

const suggestionPluginKey = new PluginKey<DecorationSet>("thoughtSuggestionReview");

/** The marked changes themselves, as opposed to the block that holds them. */
const CHANGE_CLASSES = [
  ".suggestion-inserted",
  ".suggestion-inserted-text",
  ".suggestion-deleted",
  ".suggestion-deleted-text",
].join(", ");

function blockPositions(editor: Editor, ydoc: Y.Doc): Map<string, BlockPosition> {
  const yBlocks = ydoc
    .getXmlFragment("content")
    .toArray()
    .map((node) => ({
      id: blockIdOf(node),
      kind: (node as { nodeName?: string }).nodeName ?? null,
    }));
  const editorBlocks: Array<{ node: ProseMirrorNode; offset: number }> = [];
  const kinds: string[] = [];
  editor.state.doc.forEach((node, offset) => {
    editorBlocks.push({ node, offset });
    kinds.push(node.type.name);
  });
  const ids = alignBlocks(yBlocks, kinds);
  if (!ids) return new Map();
  return new Map(
    ids.flatMap((id, index): Array<[string, BlockPosition]> => {
      const block = editorBlocks[index];
      return id && block
        ? [[id, { node: block.node, from: block.offset, to: block.offset + block.node.nodeSize }]]
        : [];
    }),
  );
}

/** Place an inserted suggestion at the current block boundary. */
export function suggestionPositionAtSelection(
  editor: Editor,
  ydoc: Y.Doc,
): SuggestionPosition {
  if (editor.state.doc.childCount === 0) return { kind: "start" };
  const positions = [...blockPositions(editor, ydoc).entries()]
    .map(([id, position]) => ({ id, ...position }))
    .sort((left, right) => left.from - right.from);
  if (positions.length === 0) {
    throw new Error("This document is still aligning with its saved version.");
  }
  const cursor = editor.state.selection.from;
  if (cursor <= positions[0].from + 1) return { kind: "start" };
  const current = positions.find(({ from, to }) => cursor >= from && cursor <= to);
  if (current) return { kind: "block", block_id: current.id };
  const previous = [...positions].reverse().find(({ to }) => to < cursor);
  return previous
    ? { kind: "block", block_id: previous.id }
    : { kind: "end" };
}

function nodeText(node: SuggestionNode): string {
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(nodeText).join("");
}

export function proposedText(patch: SuggestionPatch): string {
  if (patch.kind === "delete_block") return "";
  return patch.nodes.map(nodeText).join("\n");
}

export function suggestionTarget(patch: SuggestionPatch): string | null {
  if (patch.kind === "insert_blocks") {
    return patch.after.kind === "block" ? patch.after.block_id : null;
  }
  return patch.block_id;
}


export type DiffPart = { kind: "same" | "del" | "ins"; text: string };

/** Tokens a word diff compares: runs of word characters, spaces, or punctuation. */
function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? [];
}

const MAX_DIFF_CELLS = 250_000;

/**
 * A word-level diff of `before` into `after`, or null when the texts are too
 * long to compare cheaply. Adjacent parts of one kind are merged.
 */
export function wordDiff(before: string, after: string): DiffPart[] | null {
  const a = tokens(before);
  const b = tokens(after);
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) return null;
  // Longest common subsequence lengths, from the end.
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      // Removed words come before their replacement, as in tracked changes.
      push("del", a[i]);
      i += 1;
    } else {
      push("ins", b[j]);
      j += 1;
    }
  }
  return parts;
}

/** A textblock's text, one character per document position. */
function textblockText(block: ProseMirrorNode, blockFrom: number): { text: string; positions: number[] } {
  let text = "";
  const positions: number[] = [];
  block.forEach((child, offset) => {
    const start = blockFrom + 1 + offset;
    if (child.isText) {
      const value = child.text ?? "";
      text += value;
      for (let i = 0; i < value.length; i++) positions.push(start + i);
    } else {
      text += "￼";
      positions.push(start);
    }
  });
  return { text, positions };
}

function suggestedInlineText(node: SuggestionNode): string {
  return (node.content ?? []).map((child) => child.text ?? "￼").join("");
}

/** Whether a replacement only rewords one block, so it can be shown in place. */
function inlineDiff(
  target: BlockPosition,
  patch: SuggestionPatch,
): { parts: DiffPart[]; positions: number[] } | null {
  if (patch.kind !== "replace_text" && patch.kind !== "replace_block") return null;
  const [replacement] = patch.nodes;
  if (patch.nodes.length !== 1 || !target.node.isTextblock || replacement.type !== target.node.type.name) {
    return null;
  }
  if ((replacement.attrs?.level ?? null) !== (target.node.attrs.level ?? null)) return null;
  const { text, positions } = textblockText(target.node, target.from);
  const proposed = suggestedInlineText(replacement);
  if (text === proposed) return null;
  const parts = wordDiff(text, proposed);
  if (!parts) return null;
  // A rewrite that keeps little of the original reads better as old and new
  // blocks than as confetti.
  const kept = parts.filter(({ kind }) => kind === "same").reduce((sum, { text }) => sum + text.trim().length, 0);
  if (kept < Math.min(text.trim().length, proposed.trim().length) * 0.4) return null;
  return { parts, positions };
}

function anchorFor(
  suggestion: SuggestionRecord,
  positions: Map<string, BlockPosition>,
  document: ProseMirrorNode,
): number {
  const patch = suggestion.patch;
  if (patch.kind === "insert_blocks") {
    if (patch.after.kind === "start") return 0;
    if (patch.after.kind === "end") return document.content.size;
    return positions.get(patch.after.block_id)?.to ?? document.content.size;
  }
  return positions.get(patch.block_id)?.to ?? document.content.size;
}

export function installSuggestionReview(
  editor: Editor,
  ydoc: Y.Doc,
  documentId: string,
  client: SuggestionClient,
  options: {
    beforeDecision?: () => Promise<boolean>;
    onNotice?: (message: string, kind?: "info" | "error") => void;
  } = {},
): SuggestionReviewController {
  const root = ydoc.getMap("suggestions");
  const content = ydoc.getXmlFragment("content");
  const suggestions = new Map<string, SuggestionRecord>();
  const busy = new Set<string>();
  const errors = new Map<string, string>();
  let active: string | null = null;
  let destroyed = false;
  let generation = 0;
  let renderVersion = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshRequiresSave = false;

  function activate(id: string | null): void {
    if (active === id) return;
    active = id;
    render();
  }

  // One floating card, placed under the active suggestion. It lives beside
  // the editable surface rather than in it, so it never shifts the text.
  const card = document.createElement("div");
  card.className = "suggestion-popover";
  card.setAttribute("role", "dialog");
  card.setAttribute("contenteditable", "false");
  card.hidden = true;
  card.addEventListener("mousedown", (event) => event.stopPropagation());
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    activate(null);
    editor.commands.focus();
  });
  const host = editor.view.dom.parentElement;
  host?.append(card);

  function placeCard(): void {
    const target = active === null
      ? null
      : editor.view.dom.querySelector(`:is(${CHANGE_CLASSES})[data-suggestion-id="${CSS.escape(active)}"]`);
    if (!host || !(target instanceof HTMLElement)) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    const origin = host.getBoundingClientRect();
    // Under the first line of the change, not the whole block.
    const line = target.getClientRects()[0] ?? target.getBoundingClientRect();
    const left = Math.min(line.left - origin.left, Math.max(host.clientWidth - card.offsetWidth, 0));
    card.style.left = `${Math.max(left, 0)}px`;
    card.style.top = `${line.bottom - origin.top + 6}px`;
  }

  const plugin = new Plugin<DecorationSet>({
    key: suggestionPluginKey,
    view: () => ({ update: placeCard }),
    state: {
      init: () => DecorationSet.empty,
      apply(transaction, current) {
        const replacement = transaction.getMeta(suggestionPluginKey) as DecorationSet | undefined;
        if (replacement) return replacement;
        return transaction.docChanged ? current.map(transaction.mapping, transaction.doc) : current;
      },
    },
    props: {
      decorations(state) {
        return suggestionPluginKey.getState(state) ?? DecorationSet.empty;
      },
      handleClick(view, _pos, event) {
        const marked = (event.target as Element | null)?.closest?.("[data-suggestion-id]");
        const id = marked instanceof HTMLElement && view.dom.contains(marked)
          ? marked.dataset.suggestionId ?? null
          : null;
        activate(id);
        return false;
      },
      handleKeyDown(_view, event) {
        if (event.key !== "Escape" || active === null) return false;
        activate(null);
        return true;
      },
    },
  });

  function marked(element: HTMLElement, suggestion: SuggestionRecord): HTMLElement {
    element.dataset.suggestionId = suggestion.suggestion_id;
    element.dataset.state = suggestion.state;
    return element;
  }

  /** Proposed blocks rendered as the editor would render them. */
  function insertedBlocks(suggestion: SuggestionRecord, nodes: SuggestionNode[]): HTMLElement {
    const container = marked(document.createElement("div"), suggestion);
    container.className = `suggestion-inserted${active === suggestion.suggestion_id ? " is-active" : ""}`;
    container.setAttribute("contenteditable", "false");
    try {
      const fragment = Fragment.fromJSON(editor.schema, nodes);
      container.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(fragment));
    } catch {
      const paragraph = document.createElement("p");
      paragraph.textContent = nodes.map(nodeText).join("\n");
      container.append(paragraph);
    }
    container.addEventListener("mousedown", (event) => {
      event.preventDefault();
      activate(suggestion.suggestion_id);
    });
    return container;
  }

  function insertedWords(suggestion: SuggestionRecord, text: string): HTMLElement {
    const span = marked(document.createElement("span"), suggestion);
    span.className = `suggestion-inserted-text${active === suggestion.suggestion_id ? " is-active" : ""}`;
    span.textContent = text.split("\uFFFC").join("");
    span.addEventListener("mousedown", (event) => {
      event.preventDefault();
      activate(suggestion.suggestion_id);
    });
    return span;
  }

  function actionButton(suggestion: SuggestionRecord, kind: DecisionKind): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === "accept" ? "suggestion-accept" : "suggestion-reject";
    const label = kind === "accept" ? "Accept" : "Reject";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.disabled = busy.has(suggestion.suggestion_id);
    button.append(icon(kind === "accept" ? ICONS.check : ICONS.x));
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void decide(suggestion, kind);
    });
    return button;
  }

  function fillCard(suggestion: SuggestionRecord): void {
    card.dataset.state = suggestion.state;
    card.setAttribute("aria-label", `Suggestion from ${suggestion.proposer.label}`);
    const heading = document.createElement("div");
    heading.className = "suggestion-popover-head";
    const name = document.createElement("strong");
    name.textContent = suggestion.proposer.label;
    const actions = document.createElement("div");
    actions.className = "suggestion-actions";
    if (suggestion.state === "pending") actions.append(actionButton(suggestion, "accept"));
    actions.append(actionButton(suggestion, "reject"));
    heading.append(name, actions);
    card.replaceChildren(heading);

    if (suggestion.explanation) {
      const explanation = document.createElement("p");
      explanation.className = "suggestion-explanation";
      explanation.textContent = suggestion.explanation;
      card.append(explanation);
    }
    if (suggestion.state === "stale") {
      const stale = document.createElement("p");
      stale.className = "suggestion-stale-note";
      stale.textContent = "The note changed after this was suggested.";
      card.append(stale);
    }
    const error = errors.get(suggestion.suggestion_id);
    if (error) {
      const alert = document.createElement("p");
      alert.className = "suggestion-error";
      alert.setAttribute("role", "alert");
      alert.textContent = error;
      card.append(alert);
    }
  }

  function decorationsFor(
    suggestion: SuggestionRecord,
    positions: Map<string, BlockPosition>,
    index: number,
  ): Decoration[] {
    const id = suggestion.suggestion_id;
    const isActive = active === id;
    const attributes = (className: string) => ({
      class: `${className}${isActive ? " is-active" : ""}`,
      "data-suggestion-id": id,
      "data-state": suggestion.state,
    });
    const widget = (position: number, side: number, dom: () => HTMLElement, name: string) =>
      Decoration.widget(position, dom, {
        key: `suggestion-${id}-${name}-${suggestion.state}-${isActive}-${renderVersion}`,
        side,
        stopEvent: () => true,
        ignoreSelection: true,
      });
    const decorations: Decoration[] = [];
    const patch = suggestion.patch;
    const target = suggestionTarget(patch);
    const targetPosition = target ? positions.get(target) : undefined;
    const end = anchorFor(suggestion, positions, editor.state.doc);
    const side = 20 + index;

    if (patch.kind === "insert_blocks") {
      decorations.push(widget(end, side, () => insertedBlocks(suggestion, patch.nodes), "insert"));
    } else if (patch.kind === "delete_block") {
      if (targetPosition) {
        decorations.push(Decoration.node(targetPosition.from, targetPosition.to, attributes("suggestion-deleted")));
      }
    } else if (targetPosition) {
      const diff = inlineDiff(targetPosition, patch);
      if (diff) {
        let at = 0;
        const blockEnd = targetPosition.to - 1;
        for (const [part, { kind, text }] of diff.parts.entries()) {
          const from = diff.positions[at] ?? blockEnd;
          if (kind === "ins") {
            decorations.push(widget(from, -1, () => insertedWords(suggestion, text), `ins-${part}`));
            continue;
          }
          at += text.length;
          if (kind === "del") {
            const to = (diff.positions[at - 1] ?? blockEnd - 1) + 1;
            decorations.push(Decoration.inline(from, to, attributes("suggestion-deleted-text")));
          }
        }
        decorations.push(Decoration.node(targetPosition.from, targetPosition.to, attributes("suggestion-target")));
      } else {
        decorations.push(Decoration.node(targetPosition.from, targetPosition.to, attributes("suggestion-deleted")));
        decorations.push(widget(end, side, () => insertedBlocks(suggestion, patch.nodes), "insert"));
      }
    }
    return decorations;
  }

  function render(): void {
    if (destroyed || editor.isDestroyed) return;
    const positions = blockPositions(editor, ydoc);
    const visible = [...suggestions.values()].filter(
      ({ state }) => state === "pending" || state === "stale",
    );
    if (active !== null && !visible.some(({ suggestion_id }) => suggestion_id === active)) active = null;
    const decorations = visible.flatMap((suggestion, index) => decorationsFor(suggestion, positions, index));
    const shown = active === null ? undefined : suggestions.get(active);
    if (shown) fillCard(shown);
    renderVersion += 1;
    // Dispatching updates the plugin view, which places the card.
    editor.view.dispatch(
      editor.state.tr
        .setMeta(suggestionPluginKey, DecorationSet.create(editor.state.doc, decorations))
        .setMeta("addToHistory", false),
    );
  }

  async function decide(suggestion: SuggestionRecord, kind: DecisionKind): Promise<void> {
    if (busy.has(suggestion.suggestion_id)) return;
    busy.add(suggestion.suggestion_id);
    errors.delete(suggestion.suggestion_id);
    render();
    try {
      if (options.beforeDecision && !(await options.beforeDecision())) {
        throw new Error("Wait for this document to finish saving, then try again.");
      }
      const outcome = kind === "accept"
        ? await client.acceptSuggestion(documentId, suggestion.suggestion_id)
        : await client.rejectSuggestion(documentId, suggestion.suggestion_id);
      if (destroyed) return;
      suggestions.set(outcome.suggestion.suggestion_id, outcome.suggestion);
      editor.commands.focus();
    } catch (error) {
      if (!destroyed) {
        const message = oneLine(error, "The suggestion could not be reviewed.");
        errors.set(suggestion.suggestion_id, message);
        options.onNotice?.(message, "error");
      }
    } finally {
      busy.delete(suggestion.suggestion_id);
      render();
    }
  }

  async function refresh(): Promise<void> {
    const currentGeneration = ++generation;
    try {
      const response = await client.listSuggestions(documentId);
      if (destroyed || currentGeneration !== generation) return;
      suggestions.clear();
      for (const suggestion of response.suggestions) {
        if (suggestion.document_id === documentId) {
          suggestions.set(suggestion.suggestion_id, suggestion);
        }
      }
      render();
    } catch (error) {
      if (!destroyed && currentGeneration === generation) {
        options.onNotice?.(`Could not load suggestions: ${oneLine(error, "The suggestion could not be reviewed.")}`, "error");
      }
    }
  }

  function scheduleRefresh(requireSave = false): void {
    refreshRequiresSave ||= requireSave;
    if (refreshTimer !== null) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      const mustWait = refreshRequiresSave;
      refreshRequiresSave = false;
      void (async () => {
        if (mustWait && options.beforeDecision && !(await options.beforeDecision())) return;
        await refresh();
      })();
    }, 180);
  }

  function contentChanged(): void {
    let changed = false;
    for (const [id, suggestion] of suggestions) {
      if (suggestion.state === "pending") {
        suggestions.set(id, { ...suggestion, state: "stale" });
        changed = true;
      }
    }
    if (changed) render();
    if (suggestions.size > 0) scheduleRefresh(true);
  }

  editor.registerPlugin(plugin);
  const suggestionsChanged = () => scheduleRefresh();
  root.observe(suggestionsChanged);
  content.observeDeep(contentChanged);
  void refresh();

  return {
    refresh,
    focus(suggestionId) {
      const suggestion = suggestions.get(suggestionId);
      if (!suggestion || (suggestion.state !== "pending" && suggestion.state !== "stale")) return false;
      active = suggestionId;
      render();
      editor.view.dom
        .querySelector(`:is(${CHANGE_CLASSES})[data-suggestion-id="${CSS.escape(suggestionId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      root.unobserve(suggestionsChanged);
      content.unobserveDeep(contentChanged);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      editor.unregisterPlugin(suggestionPluginKey);
      card.remove();
      suggestions.clear();
      busy.clear();
      errors.clear();
    },
  };
}
