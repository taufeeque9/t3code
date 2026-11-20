import { type ChatHighlightRule, DEFAULT_CHAT_HIGHLIGHT_RULES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withRulePatch } from "./ChatHighlightsSettings.logic";

const custom: ChatHighlightRule = {
  id: "custom",
  label: "",
  pattern: "ship",
  regex: false,
  color: "#000000",
  enabled: true,
};

describe("withRulePatch", () => {
  it("changes only the rule with that id", () => {
    const rules = [...DEFAULT_CHAT_HIGHLIGHT_RULES, custom];
    const next = withRulePatch(rules, "custom", { pattern: "deploy" });
    expect(next?.at(-1)).toEqual({ ...custom, pattern: "deploy" });
    expect(next?.slice(0, -1)).toEqual(DEFAULT_CHAT_HIGHLIGHT_RULES);
  });

  it("drops an edit to a rule a reset removed", () => {
    expect(withRulePatch(DEFAULT_CHAT_HIGHLIGHT_RULES, "custom", { pattern: "deploy" })).toBeNull();
  });
});
