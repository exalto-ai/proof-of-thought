import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_SIDEBAR_OPEN_STORAGE_KEY,
  AI_SIDEBAR_WIDTH_STORAGE_KEY,
  PROVIDER_KEYS_CHANGED_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  installAiSupport,
} from "./ai-support";
import type { ProProviderBridge, ProviderConfiguration } from "./pro-provider-bridge";
import { memoryStorage } from "./test-storage";

const markup = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
const body = markup.slice(markup.indexOf("<body>") + 6, markup.indexOf("</body>"));

function providers(configured: ProviderConfiguration["provider"][]): ProProviderBridge {
  return {
    list: vi.fn().mockResolvedValue(
      (["openai", "anthropic"] as const).map((provider) => ({
        provider,
        configured: configured.includes(provider),
      })),
    ),
    configure: vi.fn(),
    remove: vi.fn(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sidebar = () => document.querySelector<HTMLElement>("#ai-support-sidebar")!;
const toggle = () => document.querySelector<HTMLButtonElement>("#ai-support-toggle")!;

beforeEach(() => {
  document.body.innerHTML = body;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AI sidebar", () => {
  it("is open by default with no mode chooser", () => {
    const controller = installAiSupport(document, { storage: memoryStorage() });

    expect(sidebar().hidden).toBe(false);
    expect(sidebar().hidden).toBe(false);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-ai-mode]")).toBeNull();
    expect(document.querySelector("#ai-onboarding")).toBeNull();
    controller.destroy();
  });

  it("is shown and hidden only by the toggle, which remembers the choice", () => {
    const storage = memoryStorage();
    const controller = installAiSupport(document, { storage });

    expect(document.querySelector("#ai-sidebar-close")).toBeNull();
    toggle().click();
    expect(sidebar().hidden).toBe(true);
    expect(sidebar().hidden).toBe(true);
    expect(storage.getItem(AI_SIDEBAR_OPEN_STORAGE_KEY)).toBe("false");
    controller.destroy();

    const reopened = installAiSupport(document, { storage });
    expect(sidebar().hidden).toBe(true);
    toggle().click();
    expect(sidebar().hidden).toBe(false);
    expect(storage.getItem(AI_SIDEBAR_OPEN_STORAGE_KEY)).toBe("true");
    reopened.destroy();
  });

  it("returns focus to the editor on Escape without hiding the sidebar", () => {
    const controller = installAiSupport(document, { storage: memoryStorage() });
    const editor = document.createElement("div");
    editor.className = "tiptap";
    editor.tabIndex = 0;
    document.querySelector("#editor")!.append(editor);
    sidebar().focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sidebar().hidden).toBe(false);
    expect(document.activeElement).toBe(editor);
    controller.destroy();
  });

  it("points to Settings until a provider key exists", async () => {
    const openSettings = vi.fn();
    const controller = installAiSupport(document, {
      storage: memoryStorage(),
      providerBridge: providers([]),
      openSettings,
    });
    await flush();

    expect(document.querySelector<HTMLElement>("#ai-chat-setup")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#pro-chat")!.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>("#ai-chat-setup-open")!.click();
    expect(openSettings).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it("shows chat for configured providers and picks the only one", async () => {
    const controller = installAiSupport(document, {
      storage: memoryStorage(),
      providerBridge: providers(["anthropic"]),
    });
    await flush();

    const select = document.querySelector<HTMLSelectElement>("#pro-chat-provider")!;
    expect(document.querySelector<HTMLElement>("#ai-chat-setup")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#pro-chat")!.hidden).toBe(false);
    expect(select.querySelector<HTMLOptionElement>('[value="openai"]')!.disabled).toBe(true);
    expect(select.value).toBe("anthropic");
    controller.destroy();
  });

  it("re-checks keys when Settings announces a change", async () => {
    const bridge = providers([]);
    const controller = installAiSupport(document, {
      storage: memoryStorage(),
      providerBridge: bridge,
    });
    await flush();
    vi.mocked(bridge.list).mockResolvedValue([
      { provider: "openai", configured: true },
      { provider: "anthropic", configured: false },
    ]);

    window.dispatchEvent(
      new StorageEvent("storage", { key: PROVIDER_KEYS_CHANGED_STORAGE_KEY }),
    );
    await flush();
    expect(document.querySelector<HTMLElement>("#pro-chat")!.hidden).toBe(false);
    controller.destroy();
  });

  it("resizes from the keyboard and persists the width", () => {
    const storage = memoryStorage();
    const controller = installAiSupport(document, { storage });
    const resizer = document.querySelector<HTMLElement>("#ai-sidebar-resizer")!;
    vi.spyOn(sidebar().parentElement!, "getBoundingClientRect").mockReturnValue(
      { width: 1200 } as DOMRect,
    );

    resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(storage.getItem(AI_SIDEBAR_WIDTH_STORAGE_KEY)).toBe(
      String(SIDEBAR_DEFAULT_WIDTH + 16),
    );
    expect(sidebar().style.getPropertyValue("--panel-width")).toBe(
      `${SIDEBAR_DEFAULT_WIDTH + 16}px`,
    );
    expect(resizer.getAttribute("aria-valuenow")).toBe(String(SIDEBAR_DEFAULT_WIDTH + 16));
    controller.destroy();
  });
});
