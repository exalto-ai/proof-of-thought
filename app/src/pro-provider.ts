import type {
  ProProvider,
  ProProviderBridge,
  ProviderConfiguration,
} from "./pro-provider-bridge";
import { required } from "./dom";
import { oneLine } from "./notices";

const PROVIDERS: readonly ProProvider[] = ["chatgpt", "openai", "anthropic"];
const NAMES: Record<ProProvider, string> = {
  chatgpt: "ChatGPT",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

type Options = {
  bridge?: ProProviderBridge | null;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  /** After a ChatGPT sign-in completes. */
  onSignedIn?: () => void;
  /** Open ChatGPT's usage settings. */
  openUsage?: () => void;
};

export type ProProviderController = {
  destroy(): void;
};

export function installProProvider(
  root: Document,
  options: Options = {},
): ProProviderController {
  const panel = required<HTMLElement>(root, "#provider-settings", "provider");
  const error = required<HTMLElement>(panel, "#provider-error", "provider");
  const bridge = options.bridge ?? null;
  const configured = new Map<ProProvider, boolean>();
  let account = "";
  const disposers: Array<() => void> = [];
  let busy: ProProvider | null = null;
  let destroyed = false;
  let generation = 0;

  function card(provider: ProProvider): HTMLElement {
    return required(panel, `[data-provider="${provider}"]`, "provider");
  }

  function render(): void {
    panel.setAttribute("aria-busy", String(busy !== null));
    for (const provider of PROVIDERS) {
      const container = card(provider);
      const isConfigured = configured.get(provider) === true;
      const status = required<HTMLElement>(container, "[data-provider-status]", "provider");
      const configure = required<HTMLButtonElement>(container, "[data-provider-configure]", "provider");
      const remove = required<HTMLButtonElement>(container, "[data-provider-remove]", "provider");
      status.dataset.configured = String(isConfigured);
      configure.disabled = busy !== null || bridge === null;
      remove.hidden = !isConfigured;
      remove.disabled = busy !== null || bridge === null;
      if (provider === "chatgpt") {
        // A sign-in, not a key: Continue with ChatGPT, then Sign Out.
        const waiting = busy === "chatgpt";
        status.textContent = waiting
          ? "Finish signing in in your browser…"
          : isConfigured
            ? account ? `Signed in as ${account}` : "Signed in"
            : "Not signed in";
        configure.hidden = isConfigured || waiting;
        const cancel = container.querySelector<HTMLButtonElement>("[data-provider-cancel]");
        if (cancel) cancel.hidden = !waiting;
        const manage = container.querySelector<HTMLButtonElement>("[data-provider-manage]");
        if (manage) manage.hidden = !isConfigured;
        continue;
      }
      status.textContent = isConfigured ? "Key saved" : "No key";
      configure.textContent = isConfigured ? "Replace" : "Add key";
    }
  }

  function apply(configuration: ProviderConfiguration): void {
    if (PROVIDERS.includes(configuration.provider)) {
      configured.set(configuration.provider, configuration.configured);
    }
    if (configuration.provider === "chatgpt") account = configuration.account ?? "";
  }

  async function refresh(): Promise<void> {
    if (bridge === null || destroyed) return;
    const request = ++generation;
    error.hidden = true;
    try {
      const values = await bridge.list();
      if (destroyed || request !== generation) return;
      configured.clear();
      values.forEach(apply);
    } catch (cause) {
      if (destroyed || request !== generation) return;
      error.textContent = oneLine(cause, "Provider setup failed.");
      error.hidden = false;
    }
    render();
  }

  async function configure(provider: ProProvider): Promise<void> {
    if (bridge === null || busy !== null) return;
    busy = provider;
    error.hidden = true;
    render();
    try {
      const result = await bridge.configure(provider);
      if (destroyed) return;
      apply(result.configuration);
      if (result.outcome === "saved" && provider === "chatgpt") {
        options.onNotice?.("Signed in to ChatGPT.");
        options.onSignedIn?.();
      } else if (result.outcome === "saved") {
        options.onNotice?.(`${NAMES[provider]} key saved in Keychain.`);
      }
    } catch (cause) {
      if (destroyed) return;
      error.textContent = oneLine(cause, "Provider setup failed.");
      error.hidden = false;
      options.onNotice?.(
        provider === "chatgpt" ? "Could not sign in to ChatGPT." : `Could not save ${NAMES[provider]} key.`,
        "error",
      );
    } finally {
      if (!destroyed) {
        busy = null;
        render();
      }
    }
  }

  async function remove(provider: ProProvider): Promise<void> {
    if (bridge === null || busy !== null) return;
    busy = provider;
    error.hidden = true;
    render();
    try {
      const result = await bridge.remove(provider);
      if (destroyed) return;
      apply(result.configuration);
      if (result.outcome === "removed") {
        options.onNotice?.(
          provider === "chatgpt" ? "Signed out of ChatGPT." : `${NAMES[provider]} key removed from Keychain.`,
        );
      }
    } catch (cause) {
      if (destroyed) return;
      error.textContent = oneLine(cause, "Provider setup failed.");
      error.hidden = false;
      options.onNotice?.(`Could not remove ${NAMES[provider]} key.`, "error");
    } finally {
      if (!destroyed) {
        busy = null;
        render();
      }
    }
  }

  for (const provider of PROVIDERS) {
    const configureButton = required<HTMLButtonElement>(card(provider), "[data-provider-configure]");
    const removeButton = required<HTMLButtonElement>(card(provider), "[data-provider-remove]");
    const onConfigure = () => void configure(provider);
    const onRemove = () => void remove(provider);
    configureButton.addEventListener("click", onConfigure);
    removeButton.addEventListener("click", onRemove);
    disposers.push(
      () => configureButton.removeEventListener("click", onConfigure),
      () => removeButton.removeEventListener("click", onRemove),
    );
  }

  // ChatGPT's extra controls: cancel a waiting sign-in, and manage usage.
  const chatgpt = panel.querySelector<HTMLElement>('[data-provider="chatgpt"]');
  const cancel = chatgpt?.querySelector<HTMLButtonElement>("[data-provider-cancel]");
  const manage = chatgpt?.querySelector<HTMLButtonElement>("[data-provider-manage]");
  const onCancel = () => void bridge?.cancelSignIn();
  const onManage = () => options.openUsage?.();
  cancel?.addEventListener("click", onCancel);
  manage?.addEventListener("click", onManage);
  disposers.push(
    () => cancel?.removeEventListener("click", onCancel),
    () => manage?.removeEventListener("click", onManage),
  );

  render();
  void refresh();
  return {
    destroy() {
      destroyed = true;
      generation += 1;
      disposers.splice(0).forEach((dispose) => dispose());
    },
  };
}
