import { invoke } from "@tauri-apps/api/core";
import type { ProProvider } from "./pro-provider-bridge";

export type ProviderModel = { id: string; display_name: string };
export type ProviderModels = { provider: ProProvider; models: ProviderModel[] };
export type ChatMessage = { role: "user" | "assistant"; text: string };
export type ThinkingLevel = "provider_default" | "low" | "medium" | "high";
export type ChatAttachment = {
  name: string;
  media_type: "application/pdf" | "text/plain";
  content_base64: string;
};

export type SendChatRequest = {
  document_title: string;
  document: unknown;
  provider: ProProvider;
  model: string;
  thinking: ThinkingLevel;
  messages: ChatMessage[];
  message: string;
  focus_text: string | null;
  attachments: ChatAttachment[];
  disclosure_version: 2;
};

/** Where an insertion goes, by index into the note's top-level blocks as sent. */
export type EditAnchor = { kind: "start" } | { kind: "end" } | { kind: "block"; block: number };

/**
 * One edit the model made with its tools. `block` indexes the note's
 * top-level blocks as sent; `original` is that block's Markdown as the model
 * saw it.
 */
export type ChatEdit =
  | { kind: "replace_block"; block: number; markdown: string; original: string }
  | { kind: "insert_blocks"; after: EditAnchor; markdown: string }
  | { kind: "delete_block"; block: number; original: string };

export type SendChatResponse = {
  text: string;
  edits: ChatEdit[];
  provider: ProProvider;
  requested_model: string;
  reported_model: string | null;
  wording_revision: string;
  complete: boolean;
};

export type ProChatBridge = {
  models(provider: ProProvider): Promise<ProviderModels>;
  send(request: SendChatRequest): Promise<SendChatResponse>;
};

export function tauriProChatBridge(): ProChatBridge {
  return {
    models: (provider) => invoke<ProviderModels>("provider_models", { provider }),
    send: (request) => invoke<SendChatResponse>("send_provider_chat", { request }),
  };
}
