import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const settings = readFileSync(resolve(import.meta.dirname, "../settings.html"), "utf8");
const window = readFileSync(resolve(import.meta.dirname, "../index.html"), "utf8");

describe("AI settings copy", () => {
  it("makes review, cost, and assurance differences explicit", () => {
    expect(settings).toContain("Accept and Reject");
    expect(settings).toContain("no separate API charge");
    expect(settings).toContain("Provider API charges apply");
    expect(settings).toContain("reported by the connected tool");
    expect(settings).toContain("Accepted wording is still labeled as reported AI output");
    expect(settings).toContain("login Keychain");
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
    expect(window).toContain("Sends this document");
  });
});
