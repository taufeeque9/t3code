import { describe, expect, it } from "vite-plus/test";

import { shortAccountName } from "./accountName";

describe("shortAccountName", () => {
  it("drops the provider word the section heading already shows", () => {
    expect(shortAccountName("Claude Proton", "Claude Code")).toBe("Proton");
    expect(shortAccountName("Claude Sokobans", "Claude Code")).toBe("Sokobans");
  });

  it("keeps a name that is only the provider, rather than blanking it", () => {
    expect(shortAccountName("Claude", "Claude Code")).toBe("Claude");
  });

  it("leaves names that do not start with the provider", () => {
    expect(shortAccountName("Work account", "Claude Code")).toBe("Work account");
    expect(shortAccountName("Claudia", "Claude Code")).toBe("Claudia");
  });

  it("matches case-insensitively but keeps the rest verbatim", () => {
    expect(shortAccountName("CLAUDE Work", "Claude Code")).toBe("Work");
    expect(shortAccountName("claude FAR", "Claude Code")).toBe("FAR");
  });

  it("passes the name through when the driver has no label", () => {
    expect(shortAccountName("Claude Proton", undefined)).toBe("Claude Proton");
  });

  it("works for other providers", () => {
    expect(shortAccountName("Codex Personal", "Codex")).toBe("Personal");
  });
});
