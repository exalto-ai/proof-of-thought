/**
 * The Proof tab: who and what wrote this note, and how it got here.
 *
 * A doughnut of the current text by source, a few numbers, and the note's
 * activity over time. The share chart reads `document_lineage` and, as
 * before, is shown only when the daemon's wording matches what is on screen.
 * Everything here comes from this Mac's records: AI names are as reported by
 * whatever sent them, and nothing is verified (AD-6, AD-21).
 */
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Legend,
  LinearScale,
  Tooltip,
  type ChartConfiguration,
} from "chart.js";
import type { DocumentLineage, LineageIngress } from "./mcp";
import { actorDisplayName } from "./names";
import { oneLine } from "./notices";

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  Legend,
  LinearScale,
  Tooltip,
);

export type ActivityEvent = { at: number; kind: string; ingress: string };
export type SuggestionCounts = { accepted: number; rejected: number; pending: number };
export type ChatTotals = { replies: number; elapsedMs: number };

export type ProofSources = {
  lineage(docId: string): Promise<DocumentLineage>;
  activity(docId: string): Promise<ActivityEvent[]>;
  suggestions(docId: string): Promise<SuggestionCounts>;
  chat(docId: string): ChatTotals;
  /** The wording on screen, or null while it is unsaved. */
  visibleRevision(): Promise<string | null>;
  wordCount(): number;
};

export type ProofPanel = {
  setDocument(docId: string | null): void;
  scheduleRefresh(): void;
  destroy(): void;
};

/** A slice of the share chart. `machine` slices are AI; the rest are people. */
export type ShareSlice = { label: string; amount: number; machine: boolean };

const HUMAN_INGRESS: ReadonlySet<LineageIngress> = new Set(["entered", "command"]);
const MACHINE_INGRESS: ReadonlySet<LineageIngress> = new Set(["mcp", "api", "suggestion"]);


/** The current text by source, merged into the slices a reader cares about. */
export function shareSlices(lineage: DocumentLineage): ShareSlice[] {
  const slices = new Map<string, ShareSlice>();
  for (const { group, non_whitespace_graphemes: amount } of lineage.summary.grouped_contributions) {
    if (amount <= 0) continue;
    const ingress = group.ingress as LineageIngress;
    const machine = MACHINE_INGRESS.has(ingress);
    const label = machine
      ? actorDisplayName(group.label, group.key.includes(":pro-chat:"))
      : HUMAN_INGRESS.has(ingress)
        ? "You"
        : ingress === "pasted"
          ? "Pasted"
          : ingress === "imported"
            ? "Imported"
            : "Unknown";
    const slice = slices.get(label) ?? { label, amount: 0, machine };
    slice.amount += amount;
    slices.set(label, slice);
  }
  return [...slices.values()].sort((a, b) => b.amount - a.amount);
}

const SESSION_GAP_MS = 5 * 60_000;
const SESSION_MINIMUM_MS = 60_000;

/**
 * Active writing time from a person's changes: consecutive changes less than
 * five minutes apart count as continuous work, and each sitting counts at
 * least a minute. An estimate, and labelled as one.
 */
export function activeTime(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b);
  let total = 0;
  let sessionStart: number | null = null;
  let last = 0;
  for (const at of sorted) {
    if (sessionStart !== null && at - last <= SESSION_GAP_MS) {
      last = at;
      continue;
    }
    if (sessionStart !== null) total += Math.max(last - sessionStart, SESSION_MINIMUM_MS);
    sessionStart = at;
    last = at;
  }
  if (sessionStart !== null) total += Math.max(last - sessionStart, SESSION_MINIMUM_MS);
  return total;
}

export function duration(ms: number): string {
  if (ms > 0 && ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, "") : Math.round(hours)} h`;
}

export type ActivityBuckets = { labels: string[]; human: number[]; machine: number[] };

/** Changes per day (or per hour, for a note younger than two days), up to 14 bars. */
export function activityBuckets(events: ActivityEvent[], now = Date.now()): ActivityBuckets {
  if (events.length === 0) return { labels: [], human: [], machine: [] };
  const first = Math.min(...events.map(({ at }) => at));
  const hourly = now - first < 2 * 86_400_000;
  const unit = hourly ? 3_600_000 : 86_400_000;
  const count = Math.min(14, Math.max(1, Math.ceil((now - first) / unit)));
  const start = now - count * unit;
  const human = new Array<number>(count).fill(0);
  const machine = new Array<number>(count).fill(0);
  for (const { at, kind } of events) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((at - start) / unit)));
    if (kind === "human") human[index] += 1;
    else if (kind === "agent") machine[index] += 1;
  }
  const format = new Intl.DateTimeFormat(undefined, hourly
    ? { hour: "numeric" }
    : { month: "short", day: "numeric" });
  const labels = human.map((_, index) => format.format(new Date(start + index * unit)));
  return { labels, human, machine };
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function sliceColors(slices: ShareSlice[]): string[] {
  const machine = [token("--accent"), token("--status-positive"), token("--status-caution")];
  const people: Record<string, string> = {
    You: token("--ink-soft"),
    Pasted: token("--status-caution-soft"),
    Imported: token("--status-positive-soft"),
    Unknown: token("--rule"),
  };
  let next = 0;
  return slices.map((slice) =>
    slice.machine ? machine[next++ % machine.length] : people[slice.label] ?? token("--ink-faint"));
}

/** Chart.js defaults that read like a Mac sidebar: system font, quiet ink. */
function applyChartDefaults(): void {
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = token("--ink-soft");
  Chart.defaults.borderColor = token("--rule");
  Chart.defaults.animation = false;
}

export function installProof(root: ParentNode, sources: ProofSources): ProofPanel {
  const status = root.querySelector<HTMLElement>("#proof-status")!;
  const retry = root.querySelector<HTMLButtonElement>("#proof-retry")!;
  const body = root.querySelector<HTMLElement>("#proof-body")!;
  const share = root.querySelector<HTMLCanvasElement>("#proof-share-chart")!;
  const shareNote = root.querySelector<HTMLElement>("#proof-share-note")!;
  const stats = root.querySelector<HTMLElement>("#proof-stats")!;
  const activity = root.querySelector<HTMLCanvasElement>("#proof-activity-chart")!;

  let docId: string | null = null;
  let request = 0;
  let timer: number | null = null;
  const charts: Chart[] = [];

  function clearCharts() {
    for (const chart of charts.splice(0)) chart.destroy();
  }

  function chart<T extends "doughnut" | "bar">(canvas: HTMLCanvasElement, config: ChartConfiguration<T>) {
    // A canvas with no 2D context (a test, a starved GPU) leaves the numbers.
    if (!canvas.getContext("2d")) return;
    charts.push(new Chart(canvas, config as ChartConfiguration));
  }

  function row(label: string, value: string) {
    const item = document.createElement("div");
    item.className = "settings-row";
    const name = document.createElement("dt");
    name.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    item.append(name, detail);
    return item;
  }

  function render(
    lineage: DocumentLineage | null,
    events: ActivityEvent[],
    suggestions: SuggestionCounts,
    chat: ChatTotals,
  ) {
    clearCharts();
    applyChartDefaults();

    const slices = lineage ? shareSlices(lineage) : [];
    const total = slices.reduce((sum, { amount }) => sum + amount, 0);
    share.hidden = slices.length === 0;
    shareNote.textContent = lineage === null
      ? "The share of text appears once your changes are saved."
      : slices.length === 0 ? "No text yet." : "";
    shareNote.hidden = shareNote.textContent === "";
    if (slices.length > 0) {
      const percent = (amount: number) => `${Math.round((amount / total) * 100)}%`;
      chart(share, {
        type: "doughnut",
        data: {
          labels: slices.map(({ label, amount }) => `${label} · ${percent(amount)}`),
          datasets: [{
            data: slices.map(({ amount }) => amount),
            backgroundColor: sliceColors(slices),
            borderWidth: 0,
            borderRadius: 3,
            spacing: 2,
          }],
        },
        options: {
          cutout: "68%",
          maintainAspectRatio: false,
          plugins: {
            legend: { position: "right", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 6, boxHeight: 6 } },
            tooltip: { callbacks: { label: (item) => ` ${item.label}` } },
          },
        },
      });
    }

    const human = events.filter(({ kind }) => kind === "human");
    const machine = events.filter(({ kind }) => kind === "agent");
    const decided = suggestions.accepted + suggestions.rejected + suggestions.pending;
    stats.replaceChildren(
      row("Words", sources.wordCount().toLocaleString()),
      row("Your writing time", human.length ? `≈ ${duration(activeTime(human.map(({ at }) => at)))}` : "—"),
      row("Changes", `${human.length.toLocaleString()} by you · ${machine.length.toLocaleString()} by AI`),
      row(
        "AI suggestions",
        decided === 0
          ? "None"
          : [
            suggestions.accepted && `${suggestions.accepted} accepted`,
            suggestions.rejected && `${suggestions.rejected} rejected`,
            suggestions.pending && `${suggestions.pending} pending`,
          ].filter(Boolean).join(" · "),
      ),
      row("Chat", chat.replies === 0
        ? "None"
        : `${chat.replies} ${chat.replies === 1 ? "reply" : "replies"} · ${duration(chat.elapsedMs)} of AI time`),
    );

    const buckets = activityBuckets(events);
    activity.hidden = buckets.labels.length === 0;
    if (buckets.labels.length > 0) {
      chart(activity, {
        type: "bar",
        data: {
          labels: buckets.labels,
          datasets: [
            { label: "You", data: buckets.human, backgroundColor: token("--ink-soft"), borderRadius: 2 },
            { label: "AI", data: buckets.machine, backgroundColor: token("--accent"), borderRadius: 2 },
          ],
        },
        options: {
          maintainAspectRatio: false,
          scales: {
            x: { stacked: true, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 4 } },
          },
          plugins: {
            legend: { position: "bottom", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 6, boxHeight: 6 } },
          },
        },
      });
    }
  }

  async function refresh() {
    const target = docId;
    if (!target) {
      clearCharts();
      body.hidden = true;
      retry.hidden = true;
      status.textContent = "Open a note to see how it was written.";
      status.hidden = false;
      return;
    }
    const current = ++request;
    retry.hidden = true;
    try {
      const [lineage, events, suggestions, visible] = await Promise.all([
        sources.lineage(target),
        sources.activity(target),
        sources.suggestions(target),
        sources.visibleRevision(),
      ]);
      if (current !== request || target !== docId) return;
      // Bind the share to the wording on screen; otherwise leave it out.
      const bound = visible !== null && lineage.current_wording_revision === visible ? lineage : null;
      status.hidden = true;
      body.hidden = false;
      render(bound, events, suggestions, sources.chat(target));
    } catch (error) {
      if (current !== request || target !== docId) return;
      clearCharts();
      body.hidden = true;
      status.hidden = false;
      status.textContent = `Could not load this note's history: ${oneLine(error, "unknown error", 160)}`;
      retry.hidden = false;
    }
  }

  const onThemeChange = () => void refresh();
  const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  scheme?.addEventListener?.("change", onThemeChange);
  window.addEventListener("storage", onThemeChange);
  retry.addEventListener("click", onThemeChange);

  return {
    setDocument(next) {
      docId = next;
      void refresh();
    },
    scheduleRefresh() {
      if (!docId) return;
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, 600);
    },
    destroy() {
      request += 1;
      if (timer !== null) clearTimeout(timer);
      scheme?.removeEventListener?.("change", onThemeChange);
      window.removeEventListener("storage", onThemeChange);
      retry.removeEventListener("click", onThemeChange);
      clearCharts();
    },
  };
}
