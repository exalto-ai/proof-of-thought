/**
 * Find in the open document (⌘F), as in any Mac editor: a small bar at the
 * top right of the editor, every match highlighted, ⌘G / ⇧⌘G (or Return /
 * ⇧Return) to step through them, Esc to close. Highlights are decorations,
 * so finding never edits the document or touches the shared Yjs state.
 */
import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { accel } from "./keys";

export type FindRange = { from: number; to: number };

type FindState = { query: string; index: number; matches: FindRange[] };

const findKey = new PluginKey<FindState>("find");

/**
 * Every case-insensitive occurrence of `query`, in document order. Text is
 * matched per textblock across mark boundaries ("he**llo**" contains "hello")
 * but never across blocks.
 */
export function findMatches(doc: ProseMirrorNode, query: string): FindRange[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: FindRange[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    // The block's text, and for each character the document position it sits at.
    let text = "";
    const positions: number[] = [];
    block.forEach((child, offset) => {
      const start = blockPos + 1 + offset;
      if (child.isText) {
        const value = child.text ?? "";
        text += value;
        for (let i = 0; i < value.length; i++) positions.push(start + i);
      } else {
        // An inline non-text node is one position wide and matches nothing.
        text += "￼";
        positions.push(start);
      }
    });
    const haystack = text.toLocaleLowerCase();
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
      matches.push({ from: positions[at], to: positions[at + needle.length - 1] + 1 });
    }
    return false;
  });
  return matches;
}

export const FindExtension = Extension.create({
  name: "find",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: "", index: 0, matches: [] }),
          apply(transaction, previous, _old, next) {
            const meta = transaction.getMeta(findKey) as Partial<FindState> | undefined;
            if (!meta && !transaction.docChanged) return previous;
            const query = meta?.query ?? previous.query;
            const matches = findMatches(next.doc, query);
            const wanted = meta?.index ?? previous.index;
            const index = matches.length === 0 ? 0 : ((wanted % matches.length) + matches.length) % matches.length;
            return { query, index, matches };
          },
        },
        props: {
          decorations(state) {
            const find = findKey.getState(state);
            if (!find || find.matches.length === 0) return DecorationSet.empty;
            return DecorationSet.create(
              state.doc,
              find.matches.map((match, i) =>
                Decoration.inline(match.from, match.to, {
                  class: i === find.index ? "find-match find-match-current" : "find-match",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});

/** The find bar for one editor. Returns a cleanup. */
export function installFind(editor: Editor, container: HTMLElement): () => void {
  const bar = document.createElement("div");
  bar.className = "find-bar";
  bar.setAttribute("role", "search");
  bar.hidden = true;
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Find";
  input.setAttribute("aria-label", "Find in document");
  input.spellcheck = false;
  const count = document.createElement("span");
  count.className = "find-count";
  count.setAttribute("aria-live", "polite");
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "‹";
  previous.title = "Previous (⇧⌘G)";
  previous.setAttribute("aria-label", "Previous match");
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "›";
  next.title = "Next (⌘G)";
  next.setAttribute("aria-label", "Next match");
  const done = document.createElement("button");
  done.type = "button";
  done.className = "find-done";
  done.textContent = "Done";
  bar.append(input, count, previous, next, done);
  container.append(bar);

  const state = () => findKey.getState(editor.state) ?? { query: "", index: 0, matches: [] };

  function render() {
    const { query, index, matches } = state();
    count.textContent = !query ? "" : matches.length === 0 ? "Not found" : `${index + 1} of ${matches.length}`;
    previous.disabled = next.disabled = matches.length === 0;
    // Bring the current match into view without moving the caret.
    requestAnimationFrame(() => {
      if (editor.isDestroyed) return;
      editor.view.dom
        .querySelector(".find-match-current")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  function update(meta: Partial<FindState>) {
    editor.view.dispatch(editor.state.tr.setMeta(findKey, meta).setMeta("addToHistory", false));
    render();
  }

  function open() {
    const { from, to, empty } = editor.state.selection;
    const selected = empty ? "" : editor.state.doc.textBetween(from, to, " ");
    bar.hidden = false;
    if (selected && !selected.includes("\n")) input.value = selected;
    input.focus();
    input.select();
    update({ query: input.value, index: 0 });
  }

  function step(direction: 1 | -1) {
    const { index, matches } = state();
    if (matches.length === 0) return;
    update({ index: index + direction });
  }

  function close() {
    if (bar.hidden) return;
    const { matches, index } = state();
    const current = matches[index];
    bar.hidden = true;
    update({ query: "", index: 0 });
    // Leave the caret on the match that was showing, as Mac editors do.
    if (current) editor.chain().focus().setTextSelection(current).run();
    else editor.commands.focus();
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (accel(event) && !event.altKey && event.key.toLowerCase() === "f" && !event.shiftKey) {
      event.preventDefault();
      open();
    } else if (accel(event) && !event.altKey && event.key.toLowerCase() === "g" && !bar.hidden) {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  };
  document.addEventListener("keydown", onKeyDown);
  input.addEventListener("input", () => update({ query: input.value, index: 0 }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });
  previous.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  done.addEventListener("click", close);

  return () => {
    document.removeEventListener("keydown", onKeyDown);
    bar.remove();
  };
}
