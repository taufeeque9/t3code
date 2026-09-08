import { describe, expect, it } from "vite-plus/test";

import { fuzzyMatch } from "./fuzzyMatch.ts";

describe("fuzzyMatch", () => {
  it("matches a scattered subsequence and reports where it landed", () => {
    const result = fuzzyMatch("mrg", "merge upstream");
    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedIndices).toEqual([0, 2, 3]);
  });

  it("rejects characters that appear out of order", () => {
    expect(fuzzyMatch("grm", "merge").score).toBe(0);
    expect(fuzzyMatch("zebra", "merge upstream").score).toBe(0);
  });

  it("ranks an exact substring above a scattered match of the same query", () => {
    const exact = fuzzyMatch("limits", "usage limits view");
    const scattered = fuzzyMatch("limits", "lots of interesting material in there, so");
    expect(exact.score).toBeGreaterThan(scattered.score);
  });

  it("ranks a word-boundary hit above one buried inside a word", () => {
    const boundary = fuzzyMatch("fork", "the fork feature");
    const buried = fuzzyMatch("fork", "beforkling");
    expect(boundary.score).toBeGreaterThan(buried.score);
  });

  it("prefers an early match over a late one", () => {
    const early = fuzzyMatch("sync", "sync the upstream branch");
    const late = fuzzyMatch("sync", "we should probably get around to a sync");
    expect(early.score).toBeGreaterThan(late.score);
  });

  it("requires a query space to match a real space, not the middle of a word", () => {
    // "up st" must not be satisfied by "upstream" alone.
    expect(fuzzyMatch("up st", "upstream").score).toBe(0);
    expect(fuzzyMatch("up st", "upstream is stale").score).toBeGreaterThan(0);
  });

  it("returns no match for an empty query or an oversized candidate", () => {
    expect(fuzzyMatch("", "anything").score).toBe(0);
    expect(fuzzyMatch("   ", "anything").score).toBe(0);
    expect(fuzzyMatch("a", "a".repeat(2001)).score).toBe(0);
  });

  it("is case-insensitive in both directions", () => {
    expect(fuzzyMatch("CLAUDE", "claude agent").score).toBeGreaterThan(0);
    expect(fuzzyMatch("claude", "CLAUDE AGENT").score).toBeGreaterThan(0);
  });
});
