import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { extensions } from "./schema";
import { blockIdOf } from "./provenance";
import {
  installSuggestionReview,
  proposedText,
  suggestionTarget,
  wordDiff,
  type SuggestionClient,
  type SuggestionRecord,
} from "./suggestions";

const editors: Editor[] = [];

function suggestion(overrides: Partial<SuggestionRecord> = {}): SuggestionRecord {
  return {
    version: 1,
    suggestion_id: "reviewer-one:request-one",
    document_id: "doc-one",
    request_id: "request-one",
    proposer: {
      actor_id: "reviewer:reviewer-one",
      connection_id: "reviewer-one",
      label: "Writing coach",
      source_label: "Configured for Codex (reported)",
      reported_model: null,
      session_id: null,
    },
    base_content_revision: "revision",
    patch: {
      kind: "replace_text",
      block_id: "1:0",
      nodes: [{ type: "paragraph", content: [{ type: "text", text: "Final" }] }],
    },
    explanation: "Use firmer wording",
    state: "pending",
    decision: null,
    created_at: 1,
    ...overrides,
  };
}

function editor(content = "<p>Draft</p>"): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const value = new Editor({ element, extensions, content });
  editors.push(value);
  return value;
}

/** A CRDT whose blocks line up with an editor holding `count` paragraphs. */
function paragraphs(count = 1): { ydoc: Y.Doc; ids: string[] } {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("content");
  ydoc.transact(() => {
    for (let i = 0; i < count; i++) fragment.push([new Y.XmlElement("paragraph")]);
  });
  return { ydoc, ids: fragment.toArray().map((node) => blockIdOf(node)!) };
}

function replacement(blockId: string, text: string): SuggestionRecord["patch"] {
  return {
    kind: "replace_text",
    block_id: blockId,
    nodes: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function client(record: SuggestionRecord): SuggestionClient {
  return {
    listSuggestions: vi.fn(async () => ({
      content_revision: "revision",
      suggestions: [record],
    })),
    acceptSuggestion: vi.fn(async () => ({
      content_revision: "accepted",
      suggestion: { ...record, state: "accepted" as const },
    })),
    rejectSuggestion: vi.fn(async () => ({
      content_revision: "revision",
      suggestion: { ...record, state: "rejected" as const },
    })),
  };
}

afterEach(() => {
  for (const value of editors.splice(0)) value.destroy();
  document.body.replaceChildren();
});

describe("suggestion previews", () => {
  it("extracts the proposed wording and stable target from normalized patches", () => {
    const record = suggestion();
    expect(proposedText(record.patch)).toBe("Final");
    expect(suggestionTarget(record.patch)).toBe("1:0");
    expect(suggestionTarget({
      kind: "insert_blocks",
      after: { kind: "end" },
      nodes: [],
    })).toBeNull();
  });
});

describe("word diffs", () => {
  it("keeps shared words and marks what changed", () => {
    expect(wordDiff("The quick fox", "The slow fox jumps")).toEqual([
      { kind: "same", text: "The " },
      { kind: "del", text: "quick" },
      { kind: "ins", text: "slow" },
      { kind: "same", text: " fox" },
      { kind: "ins", text: " jumps" },
    ]);
    expect(wordDiff("same", "same")).toEqual([{ kind: "same", text: "same" }]);
  });
});

describe("inline suggestions", () => {
  it("shows a reworded block as struck and inserted words in place", async () => {
    const { ydoc, ids } = paragraphs();
    const record = suggestion({ patch: replacement(ids[0], "Final draft here") });
    const value = editor("<p>First draft here</p>");
    const controller = installSuggestionReview(value, ydoc, "doc-one", client(record));

    await vi.waitFor(() => {
      expect(document.querySelector(".suggestion-deleted-text")?.textContent).toBe("First");
      expect(document.querySelector(".suggestion-inserted-text")?.textContent).toBe("Final");
    });
    // The document itself is untouched.
    expect(value.getText()).toBe("First draft here");
    controller.destroy();
  });

  it("opens a popover on click and removes the suggestion after acceptance", async () => {
    const { ydoc, ids } = paragraphs();
    const record = suggestion({ patch: replacement(ids[0], "Final draft") });
    const api = client(record);
    const value = editor("<p>First draft</p>");
    const controller = installSuggestionReview(value, ydoc, "doc-one", api, {
      beforeDecision: vi.fn(async () => true),
    });

    await vi.waitFor(() => expect(document.querySelector(".suggestion-inserted-text")).not.toBeNull());
    expect(document.querySelector<HTMLElement>(".suggestion-popover")?.hidden).toBe(true);
    document.querySelector<HTMLElement>(".suggestion-inserted-text")!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    const popover = document.querySelector<HTMLElement>(".suggestion-popover");
    expect(popover?.hidden).toBe(false);
    expect(popover?.textContent).toContain("Writing coach");
    expect(popover?.textContent).toContain("Use firmer wording");

    document.querySelector<HTMLButtonElement>(".suggestion-accept")!.click();
    await vi.waitFor(() => {
      expect(api.acceptSuggestion).toHaveBeenCalledWith("doc-one", "reviewer-one:request-one");
      expect(document.querySelector("[data-suggestion-id]")).toBeNull();
      expect(popover?.hidden).toBe(true);
    });
    controller.destroy();
  });

  it("shows inserted blocks and whole rewrites as rendered blocks", async () => {
    const { ydoc, ids } = paragraphs();
    const insert = suggestion({
      suggestion_id: "reviewer-one:insert",
      patch: {
        kind: "insert_blocks",
        after: { kind: "block", block_id: ids[0] },
        nodes: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "New section" }] }],
      },
    });
    const rewrite = suggestion({ patch: replacement(ids[0], "Something else entirely") });
    const api: SuggestionClient = {
      ...client(insert),
      listSuggestions: vi.fn(async () => ({ content_revision: "revision", suggestions: [insert, rewrite] })),
    };
    const value = editor("<p>Draft</p>");
    const controller = installSuggestionReview(value, ydoc, "doc-one", api);

    await vi.waitFor(() => {
      expect(document.querySelector(".suggestion-inserted h2")?.textContent).toBe("New section");
      expect(document.querySelector("p.suggestion-deleted")?.textContent).toBe("Draft");
      expect(document.querySelectorAll(".suggestion-inserted")).toHaveLength(2);
    });
    controller.destroy();
  });

  it("focuses a suggestion by id and offers only rejection once it is out of date", async () => {
    const { ydoc, ids } = paragraphs();
    const record = suggestion({ state: "stale", patch: replacement(ids[0], "Final draft") });
    const value = editor("<p>First draft</p>");
    const controller = installSuggestionReview(value, ydoc, "doc-one", client(record));

    await vi.waitFor(() => expect(document.querySelector(".suggestion-inserted-text")).not.toBeNull());
    expect(controller.focus("missing")).toBe(false);
    expect(controller.focus(record.suggestion_id)).toBe(true);
    expect(document.querySelector(".suggestion-stale-note")?.textContent).toContain("The note changed");
    expect(document.querySelector(".suggestion-accept")).toBeNull();
    expect(document.querySelector(".suggestion-reject")).not.toBeNull();
    controller.destroy();
  });
});
