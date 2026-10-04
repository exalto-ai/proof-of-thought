import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupDocuments, installDocumentSidebar, rowDate, type DocumentListing } from "./doc-sidebar";
import { memoryStorage } from "./test-storage";

const markup = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");
const body = markup.slice(markup.indexOf("<body>") + 6, markup.indexOf("</body>"));

// Wednesday 2026-10-07, 15:00 local time.
const NOW = new Date(2026, 9, 7, 15, 0).getTime();
const at = (month: number, day: number, year = 2026) => new Date(year, month - 1, day, 12).getTime();
const doc = (id: string, updated_at: number, title = id): DocumentListing => ({ doc_id: id, title, updated_at });

beforeEach(() => {
  document.body.innerHTML = body;
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("document grouping", () => {
  it("groups by recency like Notes, keeping order within each group", () => {
    const groups = groupDocuments(
      [
        doc("a", NOW - 1000),
        doc("b", at(10, 6)),
        doc("c", at(10, 3)),
        doc("d", at(9, 20)),
        doc("e", at(7, 4)),
        doc("f", at(12, 25, 2025)),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.label, group.documents.map((d) => d.doc_id)])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Previous 7 Days", ["c"]],
      ["Previous 30 Days", ["d"]],
      [new Date(at(7, 4)).toLocaleDateString(undefined, { month: "long" }), ["e"]],
      ["2025", ["f"]],
    ]);
  });

  it("dates rows by time today, weekday this week, otherwise the date", () => {
    expect(rowDate(NOW - 60_000, NOW)).toMatch(/\d/);
    expect(rowDate(at(10, 5), NOW)).toBe(new Date(at(10, 5)).toLocaleDateString(undefined, { weekday: "long" }));
    expect(rowDate(at(7, 4), NOW)).toBe(new Date(at(7, 4)).toLocaleDateString(undefined, {
      year: "numeric", month: "numeric", day: "numeric",
    }));
  });
});

describe("document sidebar", () => {
  function install(documents: DocumentListing[]) {
    const open = vi.fn();
    const search = vi.fn().mockResolvedValue([{ doc_id: "b", title: "Budget" }]);
    const controller = installDocumentSidebar(document, {
      storage: memoryStorage(),
      list: vi.fn().mockResolvedValue(documents),
      search,
      open,
      create: vi.fn(),
      now: () => NOW,
    });
    return { controller, open, search };
  }

  it("lists documents, marks the open one, and opens a row on click", async () => {
    const { controller, open } = install([doc("a", NOW, "Plan"), doc("b", at(10, 6), "")]);
    await controller.refresh();
    controller.setCurrent("a", "Plan");

    const rows = [...document.querySelectorAll<HTMLButtonElement>(".doc-row")];
    expect(rows.map((row) => row.querySelector(".doc-row-title")!.textContent)).toEqual(["Plan", "Untitled"]);
    expect(rows[0].getAttribute("aria-current")).toBe("page");
    rows[1].click();
    expect(open).toHaveBeenCalledWith("b");
    controller.destroy();
  });

  it("keeps the open document's title live without reordering it", async () => {
    vi.useFakeTimers();
    const { controller } = install([doc("a", NOW, "Plan"), doc("b", at(10, 6), "Old")]);
    await controller.refresh();
    controller.setCurrent("b", "Old");
    controller.setCurrent("b", "Renamed");
    vi.advanceTimersByTime(300);

    const titles = [...document.querySelectorAll(".doc-row-title")].map((t) => t.textContent);
    expect(titles).toEqual(["Plan", "Renamed"]);
    controller.destroy();
  });

  it("filters through search and opens the first result on Enter", async () => {
    vi.useFakeTimers();
    const { controller, open, search } = install([doc("a", NOW, "Plan")]);
    await controller.refresh();
    const filter = document.querySelector<HTMLInputElement>("#doc-filter")!;
    filter.value = "bud";
    filter.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(150);

    expect(search).toHaveBeenCalledWith("bud");
    expect(document.querySelector(".doc-group")!.textContent).toBe("Results");
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(open).toHaveBeenCalledWith("b");
    controller.destroy();
  });
});
