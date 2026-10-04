import { required } from "./dom";
import { ICONS, icon } from "./icons";
import { installSidePanel } from "./side-panel";

export const DOC_SIDEBAR_OPEN_STORAGE_KEY = "thought.doc-sidebar-open.v1";
export const DOC_SIDEBAR_WIDTH_STORAGE_KEY = "thought.doc-sidebar-width.v1";

const DAY_MS = 86_400_000;
const FILTER_DELAY_MS = 150;
const SAVED_REFRESH_DELAY_MS = 1000;

export type DocumentListing = { doc_id: string; title: string; updated_at: number };

export type DocumentGroup = { label: string; documents: DocumentListing[] };

type Options = {
  storage: Storage | null;
  list(): Promise<DocumentListing[]>;
  search(query: string): Promise<Array<{ doc_id: string; title: string }>>;
  open(docId: string): unknown;
  create(): unknown;
  /** Show a menu for a row; resolves when the menu closes. */
  showMenu?(document: { doc_id: string; title: string }): Promise<unknown>;
  onNotice?: (message: string, kind?: "info" | "error") => void;
  now?: () => number;
};

export type DocumentSidebarController = {
  /** Re-list documents from the daemon. */
  refresh(): Promise<void>;
  /** Re-list soon, coalescing bursts such as a run of autosaves. */
  scheduleRefresh(): void;
  /** Mark the document this window shows and keep its row title live. */
  setCurrent(docId: string | null, title?: string): void;
  destroy(): void;
};

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Group documents by recency the way macOS Notes does: Today, Yesterday,
 * the previous 7 and 30 days, then by month this year and by year before it.
 * The input order (most recently updated first) is kept within each group.
 */
export function groupDocuments(documents: DocumentListing[], now: number): DocumentGroup[] {
  const today = startOfDay(now);
  const thisYear = new Date(now).getFullYear();
  const groups: DocumentGroup[] = [];
  for (const document of documents) {
    const at = document.updated_at;
    let label: string;
    if (at >= today) label = "Today";
    else if (at >= today - DAY_MS) label = "Yesterday";
    else if (at >= today - 7 * DAY_MS) label = "Previous 7 Days";
    else if (at >= today - 30 * DAY_MS) label = "Previous 30 Days";
    else {
      const date = new Date(at);
      label = date.getFullYear() === thisYear
        ? date.toLocaleDateString(undefined, { month: "long" })
        : String(date.getFullYear());
    }
    const last = groups[groups.length - 1];
    if (last?.label === label) last.documents.push(document);
    else groups.push({ label, documents: [document] });
  }
  return groups;
}

/** A short date for a row: the time today, the weekday this week, else the date. */
export function rowDate(at: number, now: number): string {
  const today = startOfDay(now);
  const date = new Date(at);
  if (at >= today) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (at >= today - 6 * DAY_MS) return date.toLocaleDateString(undefined, { weekday: "long" });
  return date.toLocaleDateString(undefined, { year: "numeric", month: "numeric", day: "numeric" });
}

/**
 * The left sidebar: every document, newest first. Documents are a flat set
 * named by their own first line (folders are an MVP non-goal), so this is a
 * recency-grouped list with a filter rather than a tree.
 */
export function installDocumentSidebar(
  root: Document,
  options: Options,
): DocumentSidebarController {
  const sidebar = required<HTMLElement>(root, "#doc-sidebar", "documents sidebar");
  const filter = required<HTMLInputElement>(root, "#doc-filter", "documents sidebar");
  const list = required<HTMLElement>(root, "#doc-list", "documents sidebar");
  const empty = required<HTMLElement>(root, "#doc-list-empty", "documents sidebar");
  const create = required<HTMLButtonElement>(root, "#doc-new", "documents sidebar");
  const now = options.now ?? Date.now;
  const disposers: Array<() => void> = [];
  let documents: DocumentListing[] = [];
  let results: Array<{ doc_id: string; title: string }> | null = null;
  let current: string | null = null;
  let request = 0;
  let filterTimer: number | null = null;
  let renderTimer: number | null = null;
  let refreshTimer: number | null = null;

  create.append(icon(ICONS.filePlus));
  filter.before(icon(ICONS.search));

  const panel = installSidePanel(root, {
    storage: options.storage,
    panel: sidebar,
    resizer: required<HTMLElement>(root, "#doc-sidebar-resizer", "documents sidebar"),
    toggle: required<HTMLButtonElement>(root, "#doc-sidebar-toggle", "documents sidebar"),
    side: "left",
    label: "documents sidebar",
    openStorageKey: DOC_SIDEBAR_OPEN_STORAGE_KEY,
    widthStorageKey: DOC_SIDEBAR_WIDTH_STORAGE_KEY,
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 420,
  });

  function listen(target: EventTarget, event: string, listener: (event: Event) => void) {
    target.addEventListener(event, listener);
    disposers.push(() => target.removeEventListener(event, listener));
  }

  function row(document: { doc_id: string; title: string; updated_at?: number }): HTMLLIElement {
    const item = root.createElement("li");
    const button = root.createElement("button");
    button.type = "button";
    button.className = "doc-row";
    button.dataset.docId = document.doc_id;
    if (document.doc_id === current) button.setAttribute("aria-current", "page");
    const title = root.createElement("span");
    title.className = "doc-row-title";
    title.textContent = document.title || "Untitled";
    button.append(title);
    if (document.updated_at) {
      const date = root.createElement("span");
      date.className = "doc-row-date";
      date.textContent = rowDate(document.updated_at, now());
      button.append(date);
    }
    item.append(button);
    return item;
  }

  function section(label: string, rows: HTMLLIElement[]): HTMLElement {
    const group = root.createElement("section");
    const heading = root.createElement("h3");
    heading.className = "doc-group";
    heading.textContent = label;
    const items = root.createElement("ul");
    items.append(...rows);
    group.append(heading, items);
    return group;
  }

  function render() {
    if (results !== null) {
      list.replaceChildren(...(results.length ? [section("Results", results.map(row))] : []));
      empty.textContent = "No matching documents";
      empty.hidden = results.length > 0;
      return;
    }
    list.replaceChildren(
      ...groupDocuments(documents, now()).map((group) =>
        section(group.label, group.documents.map(row))
      ),
    );
    empty.textContent = "No documents yet";
    empty.hidden = documents.length > 0;
  }

  /** Coalesce bursts (typing in the open document) into one redraw. */
  function scheduleRender() {
    if (renderTimer !== null) return;
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      render();
    }, 300);
  }

  async function refresh() {
    const ticket = ++request;
    try {
      const query = filter.value.trim();
      if (query) {
        const hits = await options.search(query);
        if (ticket !== request) return;
        results = hits;
      } else {
        const listed = await options.list();
        if (ticket !== request) return;
        documents = listed;
        results = null;
      }
      render();
    } catch (error) {
      if (ticket !== request) return;
      options.onNotice?.(
        `Could not list documents: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  function rows(): HTMLButtonElement[] {
    return [...list.querySelectorAll<HTMLButtonElement>(".doc-row")];
  }

  listen(list, "click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".doc-row");
    if (button?.dataset.docId) void options.open(button.dataset.docId);
  });
  listen(list, "contextmenu", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(".doc-row");
    const docId = button?.dataset.docId;
    if (!button || !docId || !options.showMenu) return;
    event.preventDefault();
    // Ring the row the menu is about, as Finder and Notes do.
    button.classList.add("is-menu-target");
    const title = button.querySelector(".doc-row-title")?.textContent ?? "";
    void Promise.resolve(options.showMenu({ doc_id: docId, title }))
      .catch(() => undefined)
      .finally(() => button.classList.remove("is-menu-target"));
  });
  listen(list, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key !== "ArrowDown" && key !== "ArrowUp") return;
    const all = rows();
    const index = all.indexOf(root.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    if (key === "ArrowUp" && index === 0) filter.focus();
    else all[Math.min(all.length - 1, Math.max(0, index + (key === "ArrowDown" ? 1 : -1)))]?.focus();
  });
  listen(filter, "keydown", (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === "ArrowDown") {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (key === "Enter") {
      event.preventDefault();
      const first = rows()[0]?.dataset.docId;
      if (first) void options.open(first);
    }
  });
  listen(filter, "input", () => {
    if (filterTimer !== null) clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
      filterTimer = null;
      void refresh();
    }, FILTER_DELAY_MS);
  });
  listen(create, "click", () => void options.create());
  // New documents from other windows appear when this one comes forward.
  listen(window, "focus", () => {
    if (panel.isOpen()) void refresh();
  });

  return {
    refresh,
    scheduleRefresh() {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refresh();
      }, SAVED_REFRESH_DELAY_MS);
    },
    setCurrent(docId, title) {
      const changed = docId !== current;
      current = docId;
      // Only the title updates live. Order comes from the daemon's own
      // updated_at, so merely opening a document never makes it "recent".
      const entry = documents.find((document) => document.doc_id === docId);
      if (entry && title !== undefined && entry.title !== title) {
        entry.title = title;
        scheduleRender();
      }
      if (changed) render();
    },
    destroy() {
      for (const dispose of disposers.splice(0)) dispose();
      if (filterTimer !== null) clearTimeout(filterTimer);
      if (renderTimer !== null) clearTimeout(renderTimer);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      panel.destroy();
    },
  };
}
