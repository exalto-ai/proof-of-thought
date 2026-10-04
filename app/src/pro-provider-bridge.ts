import { invoke } from "@tauri-apps/api/core";

export type ProProvider = "chatgpt" | "openai" | "anthropic";

export type ProviderConfiguration = {
  provider: ProProvider;
  configured: boolean;
  /** The signed-in ChatGPT account's email. */
  account?: string;
};

export type ProviderActionResult = {
  outcome: "saved" | "removed" | "cancelled";
  configuration: ProviderConfiguration;
};

export type ProProviderBridge = {
  list(): Promise<ProviderConfiguration[]>;
  configure(provider: ProProvider): Promise<ProviderActionResult>;
  remove(provider: ProProvider): Promise<ProviderActionResult>;
  /** Stop a ChatGPT sign-in that is waiting for the browser. */
  cancelSignIn(): Promise<void>;
};

/** Where ChatGPT plan usage and this app's limit are reviewed. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/** Provider identifiers cross IPC. API keys do not. */
export function tauriProProviderBridge(): ProProviderBridge {
  return {
    list: () => invoke<ProviderConfiguration[]>("provider_configurations"),
    configure: (provider) =>
      invoke<ProviderActionResult>("configure_provider_key", { provider }),
    remove: (provider) =>
      invoke<ProviderActionResult>("remove_provider_key", { provider }),
    cancelSignIn: () => invoke<void>("cancel_chatgpt_sign_in"),
  };
}
