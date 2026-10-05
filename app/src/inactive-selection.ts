/**
 * Keep the editor's selection or caret visible while focus is elsewhere,
 * such as the chat, as a Mac app draws an inactive selection in grey. The
 * selection itself never changes; this only decorates it, so the chat can
 * refer to it and returning to the editor picks up where you left off.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

type FocusState = { focused: boolean; seen: boolean };

export const inactiveSelectionKey = new PluginKey<FocusState>("inactiveSelection");

function caret(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "inactive-caret";
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

export const InactiveSelection = Extension.create({
  name: "inactiveSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin<FocusState>({
        key: inactiveSelectionKey,
        state: {
          init: () => ({ focused: false, seen: false }),
          apply(transaction, previous) {
            const focused = transaction.getMeta(inactiveSelectionKey) as boolean | undefined;
            return focused === undefined
              ? previous
              : { focused, seen: previous.seen || focused };
          },
        },
        props: {
          handleDOMEvents: {
            focus(view) {
              view.dispatch(view.state.tr.setMeta(inactiveSelectionKey, true).setMeta("addToHistory", false));
              return false;
            },
            blur(view) {
              view.dispatch(view.state.tr.setMeta(inactiveSelectionKey, false).setMeta("addToHistory", false));
              return false;
            },
          },
          decorations(state) {
            const focus = inactiveSelectionKey.getState(state);
            // Nothing to keep before the editor has had focus at all.
            if (!focus || focus.focused || !focus.seen) return null;
            const { from, to, empty } = state.selection;
            return DecorationSet.create(state.doc, [
              empty
                ? Decoration.widget(from, caret, { key: "inactive-caret", side: -1 })
                : Decoration.inline(from, to, { class: "inactive-selection" }),
            ]);
          },
        },
      }),
    ];
  },
});
