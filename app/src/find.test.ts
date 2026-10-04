import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { FindExtension, findMatches, installFind } from "./find";
import { extensions } from "./schema";

let editor: Editor | null = null;

function makeEditor(html: string) {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({ element, extensions: [...extensions, FindExtension], content: html });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

describe("find matches", () => {
  it("matches case-insensitively, across marks, but not across blocks", () => {
    const { state } = makeEditor("<p>Hello he<strong>llo</strong> HELLO</p><p>hel</p><p>lo</p>");
    const matches = findMatches(state.doc, "hello");
    expect(matches).toHaveLength(3);
    expect(matches.map(({ from, to }) => state.doc.textBetween(from, to))).toEqual([
      "Hello",
      "hello",
      "HELLO",
    ]);
  });

  it("finds nothing for an empty query", () => {
    const { state } = makeEditor("<p>anything</p>");
    expect(findMatches(state.doc, "")).toEqual([]);
  });
});

describe("find bar", () => {
  it("opens on ⌘F, counts matches, steps with Return, and closes on Esc", () => {
    const current = makeEditor("<p>one two one three one</p>");
    const cleanup = installFind(current, document.body);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
    const bar = document.querySelector<HTMLElement>(".find-bar")!;
    const input = bar.querySelector("input")!;
    expect(bar.hidden).toBe(false);

    input.value = "one";
    input.dispatchEvent(new Event("input"));
    expect(bar.querySelector(".find-count")!.textContent).toBe("1 of 3");
    expect(current.view.dom.querySelectorAll(".find-match")).toHaveLength(3);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(bar.querySelector(".find-count")!.textContent).toBe("2 of 3");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(bar.querySelector(".find-count")!.textContent).toBe("3 of 3");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bar.hidden).toBe(true);
    expect(current.view.dom.querySelectorAll(".find-match")).toHaveLength(0);
    // The caret lands on the match that was showing.
    const { from, to } = current.state.selection;
    expect(current.state.doc.textBetween(from, to)).toBe("one");
    cleanup();
  });

  it("says Not found when nothing matches", () => {
    const current = makeEditor("<p>alpha</p>");
    const cleanup = installFind(current, document.body);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, ctrlKey: true }));
    const input = document.querySelector<HTMLInputElement>(".find-bar input")!;
    input.value = "zeta";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector(".find-count")!.textContent).toBe("Not found");
    cleanup();
  });
});
