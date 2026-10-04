import { beforeEach, describe, expect, it, vi } from "vitest";
import { installProProvider } from "./pro-provider";
import type { ProProviderBridge } from "./pro-provider-bridge";

beforeEach(() => {
  document.body.innerHTML = `
    <section id="provider-settings">
      <p id="provider-error" hidden></p>
      <div data-provider="chatgpt">
        <span data-provider-status></span>
        <button data-provider-configure></button>
        <button data-provider-cancel hidden></button>
        <button data-provider-manage hidden></button>
        <button data-provider-remove></button>
      </div>
      <div data-provider="openai">
        <span data-provider-status></span>
        <button data-provider-configure></button>
        <button data-provider-remove></button>
      </div>
      <div data-provider="anthropic">
        <span data-provider-status></span>
        <button data-provider-configure></button>
        <button data-provider-remove></button>
      </div>
    </section>`;
});

describe("provider settings", () => {
  it("shows Keychain presence without handling a secret", async () => {
    const bridge: ProProviderBridge = {
      list: vi.fn().mockResolvedValue([
        { provider: "openai", configured: true },
        { provider: "anthropic", configured: false },
      ]),
      configure: vi.fn(),
      remove: vi.fn(),
      cancelSignIn: vi.fn(),
    };
    const controller = installProProvider(document, { bridge });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-provider="openai"]')?.textContent)
        .toContain("Key saved");
    });
    expect(document.body.textContent).not.toContain("Bearer");
    controller.destroy();
  });

  it("delegates key entry and removal to native commands", async () => {
    const bridge: ProProviderBridge = {
      list: vi.fn().mockResolvedValue([
        { provider: "openai", configured: false },
        { provider: "anthropic", configured: false },
      ]),
      configure: vi.fn().mockResolvedValue({
        outcome: "saved",
        configuration: { provider: "openai", configured: true },
      }),
      remove: vi.fn().mockResolvedValue({
        outcome: "removed",
        configuration: { provider: "openai", configured: false },
      }),
      cancelSignIn: vi.fn(),
    };
    const controller = installProProvider(document, { bridge });
    await vi.waitFor(() => expect(bridge.list).toHaveBeenCalledOnce());

    document.querySelector<HTMLButtonElement>(
      '[data-provider="openai"] [data-provider-configure]',
    )!.click();
    await vi.waitFor(() => expect(bridge.configure).toHaveBeenCalledWith("openai"));

    document.querySelector<HTMLButtonElement>(
      '[data-provider="openai"] [data-provider-remove]',
    )!.click();
    await vi.waitFor(() => expect(bridge.remove).toHaveBeenCalledWith("openai"));
    controller.destroy();
  });

  it("shows ChatGPT as a sign-in, with cancel while waiting and usage once signed in", async () => {
    let finish!: (value: unknown) => void;
    const openUsage = vi.fn();
    const onSignedIn = vi.fn();
    const bridge: ProProviderBridge = {
      list: vi.fn().mockResolvedValue([{ provider: "chatgpt", configured: false }]),
      configure: vi.fn(() => new Promise((resolve) => (finish = resolve))) as never,
      remove: vi.fn(),
      cancelSignIn: vi.fn().mockResolvedValue(undefined),
    };
    const controller = installProProvider(document, { bridge, openUsage, onSignedIn });
    const row = document.querySelector<HTMLElement>('[data-provider="chatgpt"]')!;
    const button = (name: string) => row.querySelector<HTMLButtonElement>(`[data-provider-${name}]`)!;
    await vi.waitFor(() => expect(row.textContent).toContain("Not signed in"));
    expect(button("configure").hidden).toBe(false);
    expect(button("manage").hidden).toBe(true);

    button("configure").click();
    await vi.waitFor(() => expect(button("cancel").hidden).toBe(false));
    expect(row.textContent).toContain("browser");
    button("cancel").click();
    expect(bridge.cancelSignIn).toHaveBeenCalledOnce();

    finish({ outcome: "saved", configuration: { provider: "chatgpt", configured: true, account: "a@example.com" } });
    await vi.waitFor(() => expect(row.textContent).toContain("Signed in as a@example.com"));
    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(button("configure").hidden).toBe(true);
    expect(button("remove").hidden).toBe(false);
    button("manage").click();
    expect(openUsage).toHaveBeenCalledOnce();
    controller.destroy();
  });
});
