import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(import.meta.dirname, "styles.css"), "utf8");

/** The declarations inside the first `{ … }` after `selector`, in order. */
function block(selector: string): string[] {
  const start = css.indexOf(selector);
  expect(start, `${selector} is missing`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css
    .slice(open + 1, close)
    .split(";")
    .map((line) => line.replace(/\/\*[\s\S]*?\*\//g, "").trim())
    .filter(Boolean);
}

function names(declarations: string[]): string[] {
  return declarations.map((line) => line.split(":")[0].trim()).filter((name) => name.startsWith("--"));
}

describe("theme palettes", () => {
  // CSS cannot share one block between the media query (Auto) and the pinned
  // Light theme, so the palette is written twice and must not drift.
  it("keeps Auto-light and pinned Light identical", () => {
    expect(block(':root:not([data-theme="dark"])')).toEqual(block(':root[data-theme="light"]'));
  });

  it("defines every dark token for light as well", () => {
    const dark = names(block(":root {"));
    const light = names(block(':root[data-theme="light"]'));
    const themed = dark.filter((name) => !["--sans", "--display", "--mono", "--measure", "--chrome-height"].includes(name));
    expect(light.sort()).toEqual(themed.sort());
  });
});
