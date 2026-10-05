import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { InactiveSelection } from "./inactive-selection";
import { extensions } from "./schema";

const editors: Editor[] = [];

function editor(): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const value = new Editor({
    element,
    extensions: [...extensions, InactiveSelection],
    content: "<p>Keep this selected</p>",
  });
  editors.push(value);
  return value;
}

afterEach(() => {
  for (const value of editors.splice(0)) value.destroy();
  document.body.replaceChildren();
});

describe("inactive selection", () => {
  it("draws nothing before the editor has had focus", () => {
    const value = editor();
    value.commands.setTextSelection({ from: 1, to: 5 });
    expect(value.view.dom.querySelector(".inactive-selection, .inactive-caret")).toBeNull();
  });

  it("keeps a selection visible after focus moves away, and clears it on return", () => {
    const value = editor();
    value.view.dom.dispatchEvent(new FocusEvent("focus"));
    value.commands.setTextSelection({ from: 1, to: 5 });
    value.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(value.view.dom.querySelector(".inactive-selection")?.textContent).toBe("Keep");
    // The selection itself is untouched, so the chat can still read it.
    expect(value.state.selection.from).toBe(1);
    expect(value.state.selection.to).toBe(5);

    value.view.dom.dispatchEvent(new FocusEvent("focus"));
    expect(value.view.dom.querySelector(".inactive-selection")).toBeNull();
  });

  it("marks where the caret was when nothing is selected", () => {
    const value = editor();
    value.view.dom.dispatchEvent(new FocusEvent("focus"));
    value.commands.setTextSelection(6);
    value.view.dom.dispatchEvent(new FocusEvent("blur"));
    expect(value.view.dom.querySelectorAll(".inactive-caret")).toHaveLength(1);
  });
});
