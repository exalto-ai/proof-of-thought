import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProChatBridge, SendChatRequest } from "./pro-chat-bridge";
import { installProChat, type ProChatDocument } from "./pro-chat";

type ChatOptions = NonNullable<Parameters<typeof installProChat>[1]>;
type ChatStorage = NonNullable<ChatOptions["storage"]>;

function memoryStorage(): ChatStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

let storage: ChatStorage;

function installChat(options: ChatOptions = {}) {
  const controller = installProChat(document, { storage, ...options });
  // As the sidebar does: OpenAI is the one configured provider.
  controller.setProviders(["openai"]);
  return controller;
}

function markup(): string {
  return `
    <section id="pro-chat">
      <button id="pro-chat-new"></button>
      <p id="pro-chat-document"></p>
      <select id="pro-chat-model"></select>
      <select id="pro-chat-thinking">
        <option value="provider_default">Provider default</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <p id="pro-chat-error" hidden></p>
      <p id="pro-chat-storage-notice" hidden></p>
      <button id="pro-chat-retry" hidden></button>
      <p id="pro-chat-empty"></p>
      <ol id="pro-chat-messages" hidden></ol>
      <form id="pro-chat-form">
        <button id="pro-chat-attach" type="button"></button>
        <input id="pro-chat-attachment-input" type="file" multiple />
        <ul id="pro-chat-attachments" hidden></ul>
        <select id="pro-chat-mode">
          <option value="suggest">Suggest</option>
          <option value="edit">Edit</option>
        </select>
        <textarea id="pro-chat-input"></textarea>
        <button id="pro-chat-send" type="submit"></button>
      </form>
    </section>
  `;
}

function chatDocument(id = "private-document-id", title = "Draft"): ProChatDocument {
  return {
    id,
    title,
    snapshot: () => ({ type: "doc", content: [] }),
    blockIds: () => [],
    waitUntilSaved: async () => true,
    selectedText: () => null,
  };
}

function chatBridge(overrides: Partial<ProChatBridge> = {}): ProChatBridge {
  return {
    models: vi.fn().mockResolvedValue({
      provider: "openai",
      models: [
        { id: "gpt-test", display_name: "GPT Test" },
        { id: "gpt-second", display_name: "GPT Second" },
      ],
    }),
    send: vi.fn().mockResolvedValue({
      text: "Reply",
      provider: "openai",
      requested_model: "gpt-test",
      reported_model: null,
      wording_revision: "revision-1",
      complete: true,
    }),
    ...overrides,
  };
}

async function chooseOpenAi(bridge: ProChatBridge): Promise<void> {
  await vi.waitFor(() => {
    expect(bridge.models).toHaveBeenCalledWith("openai");
    expect(document.querySelector<HTMLSelectElement>("#pro-chat-model")!.value)
      .not.toBe("");
  });
}

function compose(message: string): void {
  const input = document.querySelector<HTMLTextAreaElement>("#pro-chat-input")!;
  input.value = message;
  input.dispatchEvent(new Event("input"));
}

function submitChat(): void {
  document.querySelector<HTMLFormElement>("#pro-chat-form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
}

function file(
  name: string,
  type: string,
  bytes: Uint8Array,
  declaredSize = bytes.byteLength,
): File {
  return {
    name,
    type,
    size: declaredSize,
    arrayBuffer: vi.fn().mockResolvedValue(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ),
  } as unknown as File;
}

function selectFiles(files: File[]): void {
  const input = document.querySelector<HTMLInputElement>("#pro-chat-attachment-input")!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  storage = memoryStorage();
  document.body.innerHTML = markup();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("built-in chat", () => {
  it("sends on Return and keeps Shift-Return for a new line", async () => {
    const bridge = chatBridge();
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);
    const input = document.querySelector<HTMLTextAreaElement>("#pro-chat-input")!;
    compose("Question");

    const newline = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
    input.dispatchEvent(newline);
    expect(newline.defaultPrevented).toBe(false);
    expect(bridge.send).not.toHaveBeenCalled();

    const send = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    input.dispatchEvent(send);
    expect(send.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledOnce());
    controller.destroy();
  });

  it("shares the current snapshot with the current disclosure contract", async () => {
    let sent: SendChatRequest | null = null;
    const bridge: ProChatBridge = {
      models: vi.fn().mockResolvedValue({
        provider: "openai",
        models: [{ id: "gpt-test", display_name: "GPT Test" }],
      }),
      send: vi.fn().mockImplementation(async (request: SendChatRequest) => {
        sent = request;
        return {
          text: "A clearer ending",
          edits: [],
          provider: "openai",
          requested_model: "gpt-test",
          reported_model: "gpt-test-2026",
          wording_revision: "revision-1",
          complete: true,
        };
      }),
    };
    const controller = installChat({ bridge, createRequestId: () => "suggestion-one" });
    controller.setActive(true);
    controller.setDocument({ ...chatDocument(), selectedText: () => "Selected line" });

    await vi.waitFor(() => {
      expect(bridge.models).toHaveBeenCalledWith("openai");
      expect(bridge.models).toHaveBeenCalledTimes(1);
      expect([
        document.querySelector<HTMLSelectElement>("#pro-chat-model")!.value,
        document.querySelector("#pro-chat-error")?.textContent,
      ]).toEqual(["openai:gpt-test", ""]);
    });

    const input = document.querySelector<HTMLTextAreaElement>("#pro-chat-input")!;
    const send = document.querySelector<HTMLButtonElement>("#pro-chat-send")!;
    input.value = "Improve the ending";
    input.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(false);

    document.querySelector<HTMLFormElement>("#pro-chat-form")!
      .dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(sent).not.toBeNull());
    expect(sent).toMatchObject({
      document_title: "Draft",
      document: { type: "doc", content: [] },
      message: "Improve the ending",
      focus_text: null,
      thinking: "provider_default",
      attachments: [],
      disclosure_version: 2,
    });
    expect(sent).not.toHaveProperty("document_id");
    await vi.waitFor(() => {
      expect(document.querySelector("#pro-chat-messages")?.textContent)
        .toContain("A clearer ending");
    });
    expect(document.querySelector(".pro-chat-change")).toBeNull();
    controller.destroy();
  });

  it("turns a reply's edits into suggestions the chat links to", async () => {
    const bridge = chatBridge({
      send: vi.fn().mockResolvedValue({
        text: "",
        edits: [
          { kind: "replace_block", block: 0, markdown: "## A firmer *ending*", original: "Ending" },
          { kind: "delete_block", block: 0, original: "Ending" },
          // The trailing paragraph is not saved yet: replacing it adds instead.
          { kind: "replace_block", block: 1, markdown: "Coda", original: "" },
        ],
        provider: "openai",
        requested_model: "gpt-test",
        reported_model: null,
        wording_revision: "revision-1",
        complete: true,
      }),
    });
    const suggestEdit = vi.fn()
      .mockResolvedValueOnce({ suggestion: { suggestion_id: "pro-chat:openai:one.0" } })
      .mockRejectedValueOnce(new Error("That part of the note changed."))
      .mockResolvedValueOnce({ suggestion: { suggestion_id: "pro-chat:openai:one.2" } });
    const focusSuggestion = vi.fn();
    let controller = installChat({
      bridge,
      createRequestId: () => "one",
      suggestEdit,
      focusSuggestion,
    });
    controller.setActive(true);
    controller.setDocument({ ...chatDocument(), blockIds: () => ["1:0", null] });
    await chooseOpenAi(bridge);
    compose("Tighten the ending");
    submitChat();

    await vi.waitFor(() => expect(document.querySelectorAll(".pro-chat-change")).toHaveLength(2));
    expect(suggestEdit.mock.calls.map(([input]) => [input.requestId, input.change])).toEqual([
      ["one.0", {
        kind: "replace_block",
        block_id: "1:0",
        markdown: "## A firmer *ending*",
        original: "Ending",
      }],
      ["one.1", { kind: "delete_block", block_id: "1:0", original: "Ending" }],
      ["one.2", { kind: "insert_blocks", after: { kind: "block", block_id: "1:0" }, markdown: "Coda" }],
    ]);
    expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("Could not suggest an edit: That part of the note changed.");
    const links = [...document.querySelectorAll<HTMLButtonElement>(".pro-chat-change")];
    expect(links.map((link) => link.textContent)).toEqual(["Edit: A firmer ending", "Edit: Coda"]);
    expect(document.querySelector("#pro-chat-messages")?.textContent).toContain("Suggested 2 edits.");
    links[1].click();
    expect(focusSuggestion).toHaveBeenCalledWith("pro-chat:openai:one.2");

    // Once decided in the note, a link stops being one.
    controller.setSuggestionStates(new Map([
      ["pro-chat:openai:one.0", "accepted"],
      ["pro-chat:openai:one.2", "rejected"],
    ]));
    expect([...document.querySelectorAll<HTMLElement>(".pro-chat-change")]
      .map((link) => [link.tagName, link.dataset.state])).toEqual([
      ["SPAN", "accepted"],
      ["SPAN", "rejected"],
    ]);
    controller.setSuggestionStates(new Map());

    // The links survive a restart.
    controller.destroy();
    document.body.innerHTML = markup();
    controller = installChat({ bridge, suggestEdit, focusSuggestion });
    controller.setDocument(chatDocument());
    expect([...document.querySelectorAll(".pro-chat-change")].map((link) => link.textContent))
      .toEqual(["Edit: A firmer ending", "Edit: Coda"]);
    controller.destroy();
  });

  it("shows the reply as it streams, then the finished message", async () => {
    let progress: ((event: import("./pro-chat-bridge").ChatProgress) => void) | undefined;
    let finish!: (value: Awaited<ReturnType<ProChatBridge["send"]>>) => void;
    const bridge = chatBridge({
      send: vi.fn().mockImplementation((_request, onProgress) => {
        progress = onProgress;
        return new Promise((resolve) => { finish = resolve; });
      }),
    });
    const controller = installChat({ bridge, suggestEdit: vi.fn() });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);
    compose("Tighten it");
    submitChat();

    const pending = () => document.querySelector('#pro-chat-messages li[data-pending="true"]');
    await vi.waitFor(() => expect(pending()?.textContent).toBe("Thinking…"));
    expect(document.querySelector('#pro-chat-messages li[data-role="user"]')?.textContent)
      .toContain("Tighten it");
    progress!({ kind: "text", delta: "Tightening " });
    progress!({ kind: "text", delta: "it." });
    progress!({ kind: "edit", tool: "replace_block" });
    expect(pending()?.textContent).toBe("Tightening it.Editing…");

    finish({
      text: "Tightening it.",
      edits: [],
      provider: "openai",
      requested_model: "gpt-test",
      reported_model: null,
      wording_revision: "revision-1",
      complete: true,
    });
    await vi.waitFor(() => expect(pending()).toBeNull());
    expect(document.querySelector('#pro-chat-messages li[data-role="assistant"]')?.textContent)
      .toContain("Tightening it.");
    controller.destroy();
  });

  it("applies edits directly in a note set to Edit mode, remembered per note", async () => {
    const bridge = chatBridge({
      send: vi.fn().mockResolvedValue({
        text: "",
        edits: [
          { kind: "replace_block", block: 0, markdown: "Firmer", original: "Ending" },
          { kind: "delete_block", block: 0, original: "Ending" },
        ],
        provider: "openai",
        requested_model: "gpt-test",
        reported_model: null,
        wording_revision: "revision-1",
        complete: true,
      }),
    });
    const suggestEdit = vi.fn();
    const applyEdit = vi.fn()
      .mockResolvedValueOnce({ block_id: "1:9" })
      .mockResolvedValueOnce({ block_id: null });
    const focusBlock = vi.fn();
    const controller = installChat({ bridge, suggestEdit, applyEdit, focusBlock });
    const mode = document.querySelector<HTMLSelectElement>("#pro-chat-mode")!;
    controller.setActive(true);
    controller.setDocument({ ...chatDocument("note-a"), blockIds: () => ["1:0"] });
    expect(mode.value).toBe("suggest");
    mode.value = "edit";
    mode.dispatchEvent(new Event("change"));

    // Another note starts in Suggest; coming back restores Edit.
    controller.setDocument(chatDocument("note-b"));
    expect(mode.value).toBe("suggest");
    controller.setDocument({ ...chatDocument("note-a"), blockIds: () => ["1:0"] });
    expect(mode.value).toBe("edit");

    await chooseOpenAi(bridge);
    compose("Tighten it");
    submitChat();
    await vi.waitFor(() => expect(document.querySelectorAll(".pro-chat-change")).toHaveLength(2));
    expect(suggestEdit).not.toHaveBeenCalled();
    expect(applyEdit.mock.calls.map(([input]) => input.change.kind))
      .toEqual(["replace_block", "delete_block"]);
    expect(document.querySelector("#pro-chat-messages")?.textContent).toContain("Made 2 edits.");
    const [edited, deleted] = document.querySelectorAll<HTMLElement>(".pro-chat-change");
    expect(deleted.tagName).toBe("SPAN");
    edited.click();
    expect(focusBlock).toHaveBeenCalledWith("1:9");
    controller.destroy();
  });

  it("restores isolated per-document chat and settings, while New chat clears one", async () => {
    const bridge = chatBridge();
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument("one", "One"));
    await chooseOpenAi(bridge);
    const model = document.querySelector<HTMLSelectElement>("#pro-chat-model")!;
    model.value = "openai:gpt-second";
    model.dispatchEvent(new Event("change"));
    const thinking = document.querySelector<HTMLSelectElement>("#pro-chat-thinking")!;
    thinking.value = "high";
    thinking.dispatchEvent(new Event("change"));
    compose("Question");
    submitChat();
    await vi.waitFor(() => {
      expect(document.querySelector("#pro-chat-messages")?.textContent).toContain("Reply");
    });
    expect(document.querySelector("#pro-chat-messages")?.textContent)
      .toContain("High thinking requested");

    controller.setDocument(chatDocument("two", "Two"));
    expect(document.querySelector("#pro-chat-messages")?.textContent).toBe("");
    expect(document.querySelector("#pro-chat-document")?.textContent).toContain("Two");
    // The model choice carries over; nothing is saved for a chat never used.
    expect(storage.getItem("thought.pro-chat.v1.two")).toBeNull();

    controller.setDocument(chatDocument("one", "One"));
    expect(document.querySelector("#pro-chat-messages")?.textContent).toContain("Reply");
    expect(document.querySelector("#pro-chat-messages")?.textContent)
      .toContain("High thinking requested");
    expect(document.querySelector<HTMLSelectElement>("#pro-chat-thinking")!.value).toBe("high");
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
      "#pro-chat-model",
    )!.value).toBe("openai:gpt-second"));

    document.querySelector<HTMLButtonElement>("#pro-chat-new")!.click();
    expect(document.querySelector("#pro-chat-messages")?.textContent).toBe("");
    expect(storage.getItem("thought.pro-chat.v1.one")).toBeNull();
    controller.destroy();
  });

  it("attaches files dropped on the composer", async () => {
    const bridge = chatBridge();
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);
    const form = document.querySelector<HTMLFormElement>("#pro-chat-form")!;
    const dropped = file("notes.md", "text/markdown", new TextEncoder().encode("dropped"));
    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"], files: [dropped], dropEffect: "none" },
      });
      form.dispatchEvent(event);
      return event;
    };

    expect(drag("dragover").defaultPrevented).toBe(true);
    expect(form.classList.contains("is-drop-target")).toBe(true);
    expect(drag("drop").defaultPrevented).toBe(true);
    expect(form.classList.contains("is-drop-target")).toBe(false);
    await vi.waitFor(() => expect(
      document.querySelector("#pro-chat-attachments")?.textContent,
    ).toContain("notes.md"));
    controller.destroy();
  });

  it("sends validated files once, persists only summaries, and records thinking", async () => {
    const bridge = chatBridge();
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);
    const thinking = document.querySelector<HTMLSelectElement>("#pro-chat-thinking")!;
    thinking.value = "medium";
    thinking.dispatchEvent(new Event("change"));

    const pdf = new TextEncoder().encode("%PDF-1.7\nprivate pdf bytes");
    const text = new TextEncoder().encode("private text contents");
    selectFiles([
      file("brief.pdf", "application/pdf", pdf),
      file("notes.md", "text/markdown", text),
    ]);
    await vi.waitFor(() => {
      expect(document.querySelector("#pro-chat-attachments")?.textContent)
        .toContain("brief.pdf");
      expect(document.querySelector("#pro-chat-attachments")?.textContent)
        .toContain("notes.md");
    });
    expect(storage.getItem("thought.pro-chat.v1.private-document-id"))
      .not.toContain("private text contents");

    compose("Use these files");
    submitChat();
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bridge.send).mock.calls[0][0]).toMatchObject({
      thinking: "medium",
      disclosure_version: 2,
      attachments: [
        {
          name: "brief.pdf",
          media_type: "application/pdf",
          content_base64: btoa(String.fromCharCode(...pdf)),
        },
        {
          name: "notes.md",
          media_type: "text/plain",
          content_base64: btoa(String.fromCharCode(...text)),
        },
      ],
    });
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-messages")?.textContent)
      .toContain("Medium thinking requested"));
    expect(document.querySelector("#pro-chat-messages")?.textContent).toContain("brief.pdf");
    expect(document.querySelector("#pro-chat-attachments")?.textContent).toBe("");

    const saved = storage.getItem("thought.pro-chat.v1.private-document-id")!;
    expect(saved).toContain('"name":"brief.pdf"');
    expect(saved).toContain('"size_bytes":26');
    expect(saved).not.toContain("content_base64");
    expect(saved).not.toContain("private pdf bytes");
    expect(saved).not.toContain("private text contents");

    compose("Follow up");
    submitChat();
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(bridge.send).mock.calls[1][0].attachments).toEqual([]);
    expect(vi.mocked(bridge.send).mock.calls[1][0].messages)
      .toEqual([
        { role: "user", text: "Use these files" },
        { role: "assistant", text: "Reply" },
      ]);
    controller.destroy();
  });

  it("keeps the typed message and staged files when provider delivery fails", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({
        text: "Recovered",
        provider: "openai",
        requested_model: "gpt-test",
        reported_model: null,
        wording_revision: "revision-2",
        complete: true,
      });
    const bridge = chatBridge({ send });
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);
    selectFiles([
      file("notes.txt", "text/plain", new TextEncoder().encode("retry me")),
    ]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-attachments")?.textContent)
      .toContain("notes.txt"));
    compose("Try once");
    submitChat();
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("network unavailable"));
    expect(document.querySelector<HTMLTextAreaElement>("#pro-chat-input")!.value)
      .toBe("Try once");
    expect(document.querySelector("#pro-chat-attachments")?.textContent)
      .toContain("notes.txt");

    submitChat();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0].attachments).toHaveLength(1);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-attachments")?.textContent)
      .toBe(""));
    controller.destroy();
  });

  it("rejects unsupported, duplicate, invalid UTF-8, oversized, and excess files", async () => {
    const bridge = chatBridge();
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);

    selectFiles(Array.from({ length: 6 }, (_, index) =>
      file(`${index}.txt`, "text/plain", new Uint8Array([65]))));
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("no more than 5"));

    selectFiles([
      file("large.txt", "text/plain", new Uint8Array([65]), 512 * 1024 + 1),
    ]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("512 KiB"));
    selectFiles([
      file("large.pdf", "application/pdf", new Uint8Array([37, 80, 68, 70, 45]),
        10 * 1024 * 1024 + 1),
    ]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("10 MiB"));

    selectFiles([file("bad.txt", "text/plain", new Uint8Array([0xc3, 0x28]))]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("not a UTF-8"));
    selectFiles([file("archive.zip", "application/zip", new Uint8Array([65]))]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("Only PDF and UTF-8"));
    selectFiles([file("folder/notes.txt", "text/plain", new Uint8Array([65]))]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("cannot contain paths"));

    selectFiles([file("notes.txt", "text/plain", new Uint8Array([65]))]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-attachments")?.textContent)
      .toContain("notes.txt"));
    selectFiles([file(" notes.txt ", "text/plain", new Uint8Array([66]))]);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-error")?.textContent)
      .toContain("already attached"));
    controller.destroy();
  });

  it("keeps live chat usable when storage fails and reports one concise notice", async () => {
    const failingStorage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn().mockImplementation(() => {
        throw new Error("quota unavailable");
      }),
      removeItem: vi.fn().mockImplementation(() => {
        throw new Error("quota unavailable");
      }),
    };
    const bridge = chatBridge();
    const controller = installChat({ bridge, storage: failingStorage });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);
    expect(document.querySelector<HTMLElement>("#pro-chat-storage-notice")!.hidden)
      .toBe(false);
    expect(document.querySelector("#pro-chat-storage-notice")?.textContent)
      .toBe("Saved chat is unavailable. This chat will continue in this window.");

    compose("Still works");
    submitChat();
    await vi.waitFor(() => expect(document.querySelector("#pro-chat-messages")?.textContent)
      .toContain("Reply"));
    document.querySelector<HTMLButtonElement>("#pro-chat-new")!.click();
    expect(document.querySelector("#pro-chat-messages")?.textContent).toBe("");
    expect(document.querySelectorAll("#pro-chat-storage-notice")).toHaveLength(1);
    controller.destroy();
  });

  it("preserves the last good saved history when the next record is too large", async () => {
    const assistantText = "A".repeat(64 * 1024);
    const bridge = chatBridge({
      send: vi.fn().mockResolvedValue({
        text: assistantText,
        provider: "openai",
        requested_model: "gpt-test",
        reported_model: null,
        wording_revision: "revision-large",
        complete: true,
      }),
    });
    let request = 0;
    const controller = installChat({
      bridge,
      createRequestId: () => `suggestion-${++request}`,
    });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await chooseOpenAi(bridge);

    for (let index = 0; index < 9; index += 1) {
      compose(`Question ${index}`);
      submitChat();
      await vi.waitFor(() => expect(document.querySelectorAll(
        '#pro-chat-messages li[data-role="assistant"]:not([data-pending])',
      )).toHaveLength(index + 1));
    }
    const key = "thought.pro-chat.v1.private-document-id";
    const lastGood = storage.getItem(key);
    expect(lastGood).not.toBeNull();

    compose("Question 9");
    submitChat();
    await vi.waitFor(() => expect(document.querySelectorAll(
      '#pro-chat-messages li[data-role="assistant"]:not([data-pending])',
    )).toHaveLength(10));
    expect(document.querySelector<HTMLElement>("#pro-chat-storage-notice")!.hidden)
      .toBe(false);
    expect(storage.getItem(key)).toBe(lastGood);
    controller.destroy();
  });

  it("keeps loading the shared model list across a document switch", async () => {
    const models = deferred<Awaited<ReturnType<ProChatBridge["models"]>>>();
    const bridge = chatBridge({ models: vi.fn().mockReturnValue(models.promise) });
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument("one", "One"));
    await vi.waitFor(() => expect(document.querySelector("#pro-chat")?.getAttribute(
      "aria-busy",
    )).toBe("true"));

    controller.setDocument(chatDocument("two", "Two"));
    models.resolve({
      provider: "openai",
      models: [{ id: "gpt-test", display_name: "GPT Test" }],
    });
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
      "#pro-chat-model",
    )!.value).toBe("openai:gpt-test"));
    expect(bridge.models).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it("drops a stale model list when the configured providers change", async () => {
    const models = deferred<Awaited<ReturnType<ProChatBridge["models"]>>>();
    const bridge = chatBridge({ models: vi.fn().mockReturnValue(models.promise) });
    const controller = installChat({ bridge });
    controller.setActive(true);
    controller.setDocument(chatDocument());
    await vi.waitFor(() => expect(bridge.models).toHaveBeenCalledOnce());

    controller.setProviders([]);
    models.resolve({
      provider: "openai",
      models: [{ id: "stale-model", display_name: "Stale model" }],
    });
    await models.promise;
    await Promise.resolve();
    expect(document.querySelector("#pro-chat")?.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector("#pro-chat-model optgroup")).toBeNull();
    controller.destroy();
  });

  it("offers one menu with a section per provider and Configure Providers…", async () => {
    const openSettings = vi.fn();
    const onSelectionChange = vi.fn();
    const bridge = chatBridge({
      models: vi.fn((provider: string) => Promise.resolve({
        provider,
        models: [{ id: `${provider}-model`, display_name: `${provider} model` }],
      })) as never,
    });
    const controller = installChat({ bridge, openSettings, onSelectionChange });
    controller.setProviders(["chatgpt", "openai"]);
    controller.setActive(true);
    controller.setDocument(chatDocument());
    const menu = document.querySelector<HTMLSelectElement>("#pro-chat-model")!;
    await vi.waitFor(() => expect(menu.querySelectorAll("optgroup")).toHaveLength(2));

    expect([...menu.querySelectorAll("optgroup")].map((group) => group.label))
      .toEqual(["ChatGPT Plan", "OpenAI API"]);
    expect(menu.value).toBe("chatgpt:chatgpt-model");
    expect(onSelectionChange).toHaveBeenLastCalledWith("chatgpt");

    menu.value = "openai:openai-model";
    menu.dispatchEvent(new Event("change"));
    expect(onSelectionChange).toHaveBeenLastCalledWith("openai");

    menu.value = "configure";
    menu.dispatchEvent(new Event("change"));
    expect(openSettings).toHaveBeenCalledOnce();
    expect(menu.value).toBe("openai:openai-model");
    controller.destroy();
  });

  it("disables restored conversation actions while models reload", async () => {
    const key = "thought.pro-chat.v1.private-document-id";
    storage.setItem(key, JSON.stringify({
      version: 1,
      provider: "openai",
      model: "gpt-test",
      thinking: "medium",
      messages: [
        { role: "user", text: "Question" },
        {
          role: "assistant",
          text: "Answer",
          response: {
            provider: "openai",
            requested_model: "gpt-test",
            reported_model: null,
            wording_revision: "revision-1",
            complete: true,
          },
          thinking: "medium",
          suggestionRequestId: "suggestion-one",
        },
      ],
    }));
    const models = deferred<Awaited<ReturnType<ProChatBridge["models"]>>>();
    const controller = installChat({
      bridge: chatBridge({ models: vi.fn().mockReturnValue(models.promise) }),
    });
    controller.setDocument(chatDocument());
    controller.setActive(true);
    await vi.waitFor(() => expect(document.querySelector("#pro-chat")?.getAttribute(
      "aria-busy",
    )).toBe("true"));
    expect(document.querySelector<HTMLButtonElement>("#pro-chat-new")!.disabled).toBe(true);

    models.resolve({
      provider: "openai",
      models: [{ id: "gpt-test", display_name: "GPT Test" }],
    });
    await vi.waitFor(() => expect(document.querySelector("#pro-chat")?.getAttribute(
      "aria-busy",
    )).toBe("false"));
    expect(document.querySelector<HTMLButtonElement>("#pro-chat-new")!.disabled).toBe(false);
    controller.destroy();
  });

  it("removes incomplete or unsafe saved history", () => {
    const key = "thought.pro-chat.v1.private-document-id";
    const response = {
      provider: "openai",
      requested_model: "gpt-test",
      reported_model: null,
      wording_revision: "revision-1",
      complete: true,
    };
    const malformed = [
      [{ role: "user", text: "Dangling user turn" }],
      [{ role: "user", text: "Question" }, { role: "assistant", text: "No metadata" }],
      [
        { role: "user", text: "Question" },
        {
          role: "assistant",
          text: "Unsafe retry ID",
          response,
          thinking: "medium",
          suggestionRequestId: "contains spaces",
        },
      ],
      [
        { role: "user", text: "Question" },
        {
          role: "assistant",
          text: "Unsafe response metadata",
          response: { ...response, requested_model: "model\u0085name" },
          thinking: "medium",
          suggestionRequestId: "suggestion-safe",
        },
      ],
    ];
    for (const messages of malformed) {
      document.body.innerHTML = markup();
      storage.setItem(key, JSON.stringify({
        version: 1,
        provider: "openai",
        model: "gpt-test",
        thinking: "medium",
        messages,
      }));
      const controller = installChat({ bridge: chatBridge() });
      controller.setDocument(chatDocument());
      expect(storage.getItem(key)).toBeNull();
      expect(document.querySelector<HTMLElement>("#pro-chat-storage-notice")!.hidden)
        .toBe(false);
      controller.destroy();
    }
  });

  it("blocks a full conversation without truncating saved history", async () => {
    const key = "thought.pro-chat.v1.private-document-id";

    const messages = Array.from({ length: 30 }, (_, index) => index % 2 === 0
      ? { role: "user", text: `Question ${index / 2}` }
      : {
          role: "assistant",
          text: `Answer ${(index - 1) / 2}`,
          response: {
            provider: "openai",
            requested_model: "gpt-test",
            reported_model: null,
            wording_revision: `revision-${index}`,
            complete: true,
          },
          thinking: "provider_default",
          suggestionRequestId: `suggestion-${index}`,
        });
    storage.setItem(key, JSON.stringify({
      version: 1,
      provider: "openai",
      model: "gpt-test",
      thinking: "provider_default",
      messages,
    }));
    const bridge = chatBridge();
    const controller = installChat({ bridge });
    controller.setDocument(chatDocument());
    controller.setActive(true);
    await vi.waitFor(() => expect(document.querySelector<HTMLSelectElement>(
      "#pro-chat-model",
    )!.value).toBe("openai:gpt-test"));
    compose("One too many");
    submitChat();
    expect(document.querySelector("#pro-chat-error")?.textContent)
      .toBe("This conversation is full. Start a new chat.");
    expect(bridge.send).not.toHaveBeenCalled();
    controller.destroy();
  });
});
