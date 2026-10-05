import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settings = readFileSync(resolve(import.meta.dirname, "../settings.html"), "utf8");
const window = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");

describe("AI settings copy", () => {
  it("keeps the few statements that are not self-evident", () => {
    // Attribution is reported, never verified (AD-6, AD-21).
    expect(settings).toContain("as the app reports them");
    expect(settings).toContain("may send note text to its own provider");
    expect(settings).toContain("login Keychain");
    expect(settings).toContain("Provider API charges apply");
  });

  it("offers the four supported local setup paths", () => {
    expect(settings).toContain("ChatGPT desktop");
    expect(settings).toContain(">Codex<");
    expect(settings).toContain("Claude Code");
    expect(settings).toContain('value="claude-desktop"');
  });

  it("keeps configuration out of the document window", () => {
    expect(window).not.toContain('id="provider-settings"');
    expect(window).not.toContain('id="reviewer-form"');
    expect(window).toContain(">Using ChatGPT plan</p>");
  });
});
