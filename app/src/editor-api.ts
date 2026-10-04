import type { DocumentView } from "./mcp";
import type { ProProvider } from "./pro-provider-bridge";
import type { ActivityEvent } from "./proof";
import type {
  ReviewerApi,
  ReviewerConnection,
  ReviewerInput,
} from "./reviewer-connections";
import type {
  SuggestionDecisionOutcome,
  SuggestionList,
  SuggestionPosition,
} from "./suggestions";

/** A chat edit addressed to the note's blocks by id. */
export type ChatChange =
  | { kind: "insert_blocks"; after: SuggestionPosition; markdown: string }
  | { kind: "replace_block"; block_id: string; markdown: string; original: string }
  | { kind: "delete_block"; block_id: string; original: string };

export type ChatSuggestionInput = {
  documentId: string;
  requestId: string;
  provider: ProProvider;
  requestedModel: string;
  reportedModel: string | null;
  change: ChatChange;
};

export class EditorApi implements ReviewerApi {
  private readonly baseUrl: string;

  constructor(
    mcpUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.baseUrl = new URL(mcpUrl).origin;
  }

  createDocument(title: string, initialMarkdown?: string): Promise<DocumentView> {
    return this.request("POST", "/editor/documents", {
      title,
      ...(initialMarkdown === undefined ? {} : { markdown: initialMarkdown }),
    });
  }

  setDocumentDeleted(docId: string, deleted: boolean): Promise<unknown> {
    return this.request("POST", `/editor/documents/${encodeURIComponent(docId)}/deletion`, {
      deleted,
    });
  }

  listSuggestions(docId: string): Promise<SuggestionList> {
    return this.request(
      "GET",
      `/editor/documents/${encodeURIComponent(docId)}/suggestions`,
    );
  }

  /** Every recorded change to a note, oldest first, for the Proof tab. */
  async documentActivity(docId: string): Promise<ActivityEvent[]> {
    const { events } = await this.request<{ events: ActivityEvent[] }>(
      "GET",
      `/editor/documents/${encodeURIComponent(docId)}/activity`,
    );
    return events;
  }

  proposeChatSuggestion(input: ChatSuggestionInput): Promise<SuggestionDecisionOutcome> {
    return this.request(
      "POST",
      `/editor/documents/${encodeURIComponent(input.documentId)}/suggestions/pro-chat`,
      {
        request_id: input.requestId,
        provider: input.provider,
        requested_model: input.requestedModel,
        reported_model: input.reportedModel,
        change: input.change,
      },
    );
  }

  /** Apply a chat edit directly, for a note in Edit mode. */
  applyChatEdit(input: ChatSuggestionInput): Promise<{ block_id: string | null }> {
    return this.request(
      "POST",
      `/editor/documents/${encodeURIComponent(input.documentId)}/edits/pro-chat`,
      {
        request_id: input.requestId,
        provider: input.provider,
        requested_model: input.requestedModel,
        reported_model: input.reportedModel,
        change: input.change,
      },
    );
  }

  acceptSuggestion(
    docId: string,
    suggestionId: string,
  ): Promise<SuggestionDecisionOutcome> {
    return this.request(
      "POST",
      `/editor/documents/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(suggestionId)}/accept`,
    );
  }

  rejectSuggestion(
    docId: string,
    suggestionId: string,
  ): Promise<SuggestionDecisionOutcome> {
    return this.request(
      "POST",
      `/editor/documents/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(suggestionId)}/reject`,
    );
  }

  async listReviewerConnections(): Promise<ReviewerConnection[]> {
    const value = await this.request<{ connections: ReviewerConnection[] }>(
      "GET",
      "/editor/reviewer-connections",
    );
    return value.connections;
  }

  createReviewerConnection(input: ReviewerInput): Promise<ReviewerConnection> {
    return this.connection(
      this.request("POST", "/editor/reviewer-connections", input),
    );
  }

  updateReviewerConnection(
    id: string,
    input: Omit<ReviewerInput, "client"> & { expected_revision: number },
  ): Promise<ReviewerConnection> {
    return this.connection(
      this.request(
        "PATCH",
        `/editor/reviewer-connections/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  resetReviewerConnection(id: string, expectedRevision: number): Promise<ReviewerConnection> {
    return this.connection(
      this.request(
        "POST",
        `/editor/reviewer-connections/${encodeURIComponent(id)}/reset`,
        { expected_revision: expectedRevision },
      ),
    );
  }

  revokeReviewerConnection(id: string, expectedRevision: number): Promise<ReviewerConnection> {
    return this.connection(
      this.request(
        "DELETE",
        `/editor/reviewer-connections/${encodeURIComponent(id)}`,
        { expected_revision: expectedRevision },
      ),
    );
  }

  private async connection(
    request: Promise<{ connection: ReviewerConnection }>,
  ): Promise<ReviewerConnection> {
    return (await request).connection;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(new URL(path, this.baseUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let value: unknown = raw;
    try {
      value = raw ? JSON.parse(raw) : null;
    } catch {
      // Plain-text errors from Axum are already suitable for the toast.
    }
    if (!response.ok) {
      throw new Error(
        typeof value === "string"
          ? value
          : ((value as { error?: string } | null)?.error ??
              `editor request failed (${response.status})`),
      );
    }
    return value as T;
  }
}

/** Temporary source compatibility for callers that only use document methods. */
export { EditorApi as EditorDocuments };
