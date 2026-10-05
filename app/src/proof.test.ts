import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentLineage } from "./mcp";
import {
  activeTime,
  activityBuckets,
  duration,
  installProof,
  shareSlices,
  type ProofSources,
} from "./proof";

function lineage(revision = "revision-a"): DocumentLineage {
  const group = (label: string, ingress: string, amount: number, key = label) => ({
    group: { key, label, ingress: ingress as never, assurance: "observed", alignment: "exact" },
    event_count: 1,
    graphemes: amount,
    non_whitespace_graphemes: amount,
  });
  return {
    doc_id: "doc-a",
    current_wording_revision: revision,
    summary: {
      total_graphemes: 100,
      total_non_whitespace_graphemes: 100,
      contributions: [],
      grouped_contributions: [
        group("Written here", "entered", 20),
        group("Edited here", "command", 5),
        group("Suggestion from ChatGPT chat (reported)", "suggestion", 60, "suggestion:connection:pro-chat:chatgpt"),
        group("ChatGPT chat (reported)", "api", 10, "chat:connection:pro-chat:chatgpt"),
        group("Pasted", "pasted", 5),
      ],
    },
    spans: [],
  } as DocumentLineage;
}

function markup() {
  document.body.innerHTML = `
    <p id="proof-status"></p>
    <button id="proof-retry" hidden></button>
    <div id="proof-body" hidden>
      <canvas id="proof-share-chart"></canvas>
      <p id="proof-share-note" hidden></p>
      <dl id="proof-stats"></dl>
      <canvas id="proof-activity-chart"></canvas>
    </div>
  `;
}

function sources(overrides: Partial<ProofSources> = {}): ProofSources {
  return {
    lineage: vi.fn(async () => lineage()),
    activity: vi.fn(async () => [
      { at: 0, kind: "human", ingress: "entered" },
      { at: 120_000, kind: "human", ingress: "entered" },
      { at: 130_000, kind: "agent", ingress: "suggestion" },
    ]),
    suggestions: vi.fn(async () => ({ accepted: 2, rejected: 1, pending: 0 })),
    chat: vi.fn(() => ({ replies: 3, elapsedMs: 95_000 })),
    visibleRevision: vi.fn(async () => "revision-a"),
    wordCount: () => 1234,
    ...overrides,
  };
}

describe("proof numbers", () => {
  it("merges sources into slices a reader recognizes", () => {
    expect(shareSlices(lineage())).toEqual([
      { label: "ChatGPT", amount: 70, machine: true },
      { label: "You", amount: 25, machine: false },
      { label: "Pasted", amount: 5, machine: false },
    ]);
  });

  it("estimates writing time from sittings, at least a minute each", () => {
    expect(activeTime([])).toBe(0);
    expect(activeTime([0])).toBe(60_000);
    // Two changes four minutes apart are one sitting; an hour later is another.
    expect(activeTime([0, 240_000, 3_840_000])).toBe(240_000 + 60_000);
    expect(duration(30_000)).toBe("30 s");
    expect(duration(25 * 60_000)).toBe("25 min");
    expect(duration(90 * 60_000)).toBe("1.5 h");
  });

  it("buckets activity by hour for a young note and by day otherwise", () => {
    const now = 10 * 3_600_000;
    const hourly = activityBuckets([
      { at: now - 2.5 * 3_600_000, kind: "human", ingress: "entered" },
      { at: now - 60_000, kind: "agent", ingress: "api" },
    ], now);
    expect(hourly.human).toEqual([1, 0, 0]);
    expect(hourly.machine).toEqual([0, 0, 1]);
    const daily = activityBuckets([{ at: now - 30 * 86_400_000, kind: "human", ingress: "entered" }], now);
    expect(daily.labels).toHaveLength(14);
    expect(daily.human[0]).toBe(1);
    expect(activityBuckets([])).toEqual({ labels: [], human: [], machine: [] });
  });
});

describe("proof panel", () => {
  beforeEach(markup);
  afterEach(() => vi.useRealTimers());

  it("shows the note's numbers", async () => {
    const panel = installProof(document, sources());
    panel.setDocument("doc-a");
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#proof-body")!.hidden).toBe(false));
    const text = document.querySelector("#proof-stats")!.textContent;
    expect(text).toContain("1,234");
    expect(text).toContain("≈ 2 min");
    expect(text).toContain("2 by you · 1 by AI");
    expect(text).toContain("2 accepted · 1 rejected");
    expect(text).toContain("3 replies · 2 min of AI time");
    expect(document.querySelector<HTMLElement>("#proof-share-note")!.hidden).toBe(true);
    panel.destroy();
  });

  it("leaves out the share while the wording on screen is unsaved", async () => {
    const panel = installProof(document, sources({ visibleRevision: vi.fn(async () => null) }));
    panel.setDocument("doc-a");
    await vi.waitFor(() => expect(document.querySelector("#proof-share-note")?.textContent)
      .toContain("once your changes are saved"));
    expect(document.querySelector<HTMLElement>("#proof-share-chart")!.hidden).toBe(true);
    panel.destroy();
  });

  it("says why it could not load, and offers a retry", async () => {
    const panel = installProof(document, sources({
      activity: vi.fn(async () => {
        throw new Error("MCP request failed (500)");
      }),
    }));
    panel.setDocument("doc-a");
    await vi.waitFor(() => expect(document.querySelector("#proof-status")?.textContent)
      .toBe("Could not load this note's history: MCP request failed (500)"));
    expect(document.querySelector<HTMLElement>("#proof-retry")!.hidden).toBe(false);
    panel.destroy();
  });
});
