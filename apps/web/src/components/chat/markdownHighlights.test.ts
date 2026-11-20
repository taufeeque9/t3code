import { type ChatHighlightRule, DEFAULT_CHAT_HIGHLIGHT_RULES } from "@t3tools/contracts";
import {
  CHAT_MARKDOWN_REHYPE_PLUGINS,
  CHAT_MARKDOWN_REMARK_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  compileHighlightRules,
  findHighlightMatches,
  highlightRuleProblem,
  highlightRuleRegex,
  MAX_HIGHLIGHT_MARKS_PER_BLOCK,
  withChatHighlights,
} from "./markdownHighlights";
import { createMarkdownRenderer } from "./markdownRenderer";

const rule = (pattern: string, overrides: Partial<ChatHighlightRule> = {}): ChatHighlightRule => ({
  id: pattern,
  label: "",
  pattern,
  regex: false,
  color: "#000000",
  enabled: true,
  ...overrides,
});

function highlighted(text: string, rules: ReadonlyArray<ChatHighlightRule>) {
  return findHighlightMatches(text, compileHighlightRules(rules)).map(({ start, end, rule }) => [
    text.slice(start, end),
    rule,
  ]);
}

const DEFAULT_LABELS = DEFAULT_CHAT_HIGHLIGHT_RULES.filter((entry) => entry.enabled).map(
  (entry) => entry.label,
);
function highlightedByDefaults(text: string) {
  return highlighted(text, DEFAULT_CHAT_HIGHLIGHT_RULES).map(([match, index]) => [
    match,
    DEFAULT_LABELS[index as number],
  ]);
}

describe("highlightRuleRegex", () => {
  it.each(DEFAULT_CHAT_HIGHLIGHT_RULES.map((entry) => [entry.label, entry] as const))(
    "compiles the default %s rule",
    (_label, entry) => {
      expect(highlightRuleRegex(entry)).not.toBeNull();
    },
  );

  it.each([
    ["an invalid expression", rule("(unclosed", { regex: true })],
    ["an empty phrase", rule("   ")],
    ["an empty expression", rule("", { regex: true })],
  ])("skips %s", (_name, entry) => {
    expect(highlightRuleRegex(entry)).toBeNull();
  });
});

describe("highlightRuleProblem", () => {
  it.each([
    ["(a+)+", "slow"],
    ["(a*)*", "slow"],
    ["(a|aa)+", "slow"],
    [String.raw`(\w+\s?)*`, "slow"],
    ["(?:x+){2,}", "slow"],
    ["((a)+)+", "slow"],
    ["(?<word>a|b)*", "slow"],
    ["(a+)?", null],
    ["(?:is |are )?yours", null],
    ["a+b*(c)+", null],
    ["[(a+)]+", null],
    [String.raw`\(a+\)+`, null],
    [String.raw`(?<!\b(?:no|not)\s)done`, null],
    ["(unclosed", "invalid"],
  ])("%s → %s", (pattern, problem) => {
    expect(highlightRuleProblem(rule(pattern, { regex: true }))).toBe(problem);
  });

  it("never flags a phrase rule", () => {
    expect(highlightRuleProblem(rule("(a+)+"))).toBeNull();
  });
});

describe("findHighlightMatches", () => {
  it.each([
    [
      "matches a phrase case-insensitively",
      "Want me to push?",
      [rule("want me to")],
      ["Want me to"],
    ],
    ["matches phrases as whole words", "pushed or push", [rule("push")], ["push"]],
    ["treats accented letters as word letters", "caféteria café", [rule("café")], ["café"]],
    ["needs a boundary before the phrase", "épush push", [rule("push")], ["push"]],
    [
      "resumes after a match, not after the rule's",
      "a b b b",
      [rule("a b"), rule("b b")],
      ["a b", "b b"],
    ],
    ["leaves skill tokens whole", "Use $deploy now.", [rule("deploy")], []],
    ["leaves mentions whole", "Ask @deploy now.", [rule("deploy")], []],
    [
      "highlights around a skill token",
      "Should I run $deploy now?",
      [rule("[^.?]+\\?", { regex: true })],
      ["Should I run", "now?"],
    ],
    ["escapes phrase syntax", "a.b and axb", [rule("a.b")], ["a.b"]],
    ["skips word boundaries beside punctuation", "see (TODO) now", [rule("(todo)")], ["(TODO)"]],
    ["matches a phrase with a dash", "a re-run now", [rule("re-run")], ["re-run"]],
    ["reads a regex rule", "ran 12 tests", [rule("\\d+ tests", { regex: true })], ["12 tests"]],
    ["drops zero-length matches", "abc", [rule("x*", { regex: true })], []],
    [
      "trims whitespace from match edges",
      "Done. Ok?",
      [rule("[^.]+\\?", { regex: true })],
      ["Ok?"],
    ],
    ["skips disabled rules", "push", [rule("push", { enabled: false })], []],
    [
      "skips a rule that does not compile",
      "push",
      [rule("(", { regex: true }), rule("push")],
      ["push"],
    ],
  ])("%s", (_name, text, rules, expected) => {
    expect(highlighted(text, rules).map(([match]) => match)).toEqual(expected);
  });

  it("stops at the limit", () => {
    expect(findHighlightMatches("a a a a", compileHighlightRules([rule("a")]), 2)).toHaveLength(2);
  });

  it("keeps the earliest start, and the earlier rule on a tie", () => {
    const rules = [rule("merge it"), rule("I merge"), rule("merge")];
    expect(highlighted("Should I merge it", rules)).toEqual([["I merge", 1]]);
    expect(highlighted("merge it", rules)).toEqual([["merge it", 0]]);
  });
});

describe("default highlight rules", () => {
  it.each([
    ["Nothing pending.", []],
    ["No pending decisions remain.", []],
    ["One pending decision: the port.", [["pending decision", "Open decision"]]],
    ["No unverified claims.", []],
    ["Two untested paths.", [["untested", "Unverified"]]],
    ["zero OOMs, zero OOM, no out of memory", []],
    ["It hit OOM twice.", [["OOM", "Failure"]]],
    ["never blocked on review", []],
    ["zero timed out", []],
    ["The job timed out.", [["timed out", "Failure"]]],
    ["not dropped", []],
    ["I dropped the table.", [["dropped", "Destructive"]]],
    ["The fix is not pushed.", [["not pushed", "Not done"]]],
    ["I pushed the fix.", [["pushed", "Action taken"]]],
    ["Should I merge it?", [["Should I merge", "Permission ask"]]],
    ["Done. Which port should it use? Tell me.", [["Which port should it use?", "Question"]]],
    ["Options: which port?", [["which port?", "Question"]]],
    ["Waiting: on: the: build: here", []],
  ])("%j", (text, expected) => {
    expect(highlightedByDefaults(text)).toEqual(expected);
  });
});

describe("rehypeChatHighlights", () => {
  const rules = [rule("deploy", { color: "#22c55e" })];
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: withChatHighlights(CHAT_MARKDOWN_REHYPE_PLUGINS, rules),
    components: {},
    urlTransform: (url) => url,
  });
  const markup = (source: string) => renderToStaticMarkup(render(source));
  const MARK =
    '<mark class="chat-highlight" data-chat-highlight="" style="--chat-highlight:#22c55e">deploy</mark>';

  it("wraps prose matches after sanitizing", () => {
    expect(markup("We **deploy** now")).toBe(`<p>We <strong>${MARK}</strong> now</p>`);
  });

  it("highlights inside an agent callout", () => {
    expect(markup("> [!NOTE]\n> We deploy now")).toContain(MARK);
  });

  it("leaves a skill token whole", () => {
    expect(markup("Use $deploy now.")).not.toContain("<mark");
  });

  it("caps the marks in one block", () => {
    const one = createMarkdownRenderer({
      remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
      rehypePlugins: withChatHighlights(CHAT_MARKDOWN_REHYPE_PLUGINS, [rule("a")]),
      components: {},
      urlTransform: (url) => url,
    });
    const marks = renderToStaticMarkup(one("a ".repeat(500))).split("<mark").length - 1;
    expect(marks).toBe(MAX_HIGHLIGHT_MARKS_PER_BLOCK);
  });

  it.each([
    ["inline code", "Run `deploy` now"],
    ["a code block", "```\ndeploy\n```"],
    ["a link", "[deploy](https://example.com)"],
    ["a quote", "> deploy it"],
    ["a kbd element", "Press <kbd>deploy</kbd>"],
  ])("leaves %s alone", (_name, source) => {
    expect(markup(source)).not.toContain("<mark");
  });
});

describe("rehypeChatHighlights with the default rules", () => {
  const render = createMarkdownRenderer({
    remarkPlugins: CHAT_MARKDOWN_REMARK_PLUGINS,
    rehypePlugins: withChatHighlights(CHAT_MARKDOWN_REHYPE_PLUGINS, DEFAULT_CHAT_HIGHLIGHT_RULES),
    components: {},
    urlTransform: (url) => url,
  });
  const mark = (color: string, text: string) =>
    `<mark class="chat-highlight" data-chat-highlight="" style="--chat-highlight:${color}">${text}</mark>`;

  it.each([
    [
      "keeps a negation across emphasis",
      "I have not **pushed**.",
      `<p>I ${mark("#a855f7", "have not ")}<strong>${mark("#a855f7", "pushed")}</strong>.</p>`,
    ],
    [
      "highlights a question with bold inside it",
      "Which **port**?",
      `<p>${mark("#3b82f6", "Which ")}<strong>${mark("#3b82f6", "port")}</strong>${mark("#3b82f6", "?")}</p>`,
    ],
    [
      "breaks a match at inline code",
      "Did `vp` really crash?",
      `<p>Did <code data-inline-code="">vp</code> really ${mark("#ef4444", "crash")}?</p>`,
    ],
  ])("%s", (_name, source, expected) => {
    expect(renderToStaticMarkup(render(source))).toBe(expected);
  });
});

describe("withChatHighlights", () => {
  const base = CHAT_MARKDOWN_REHYPE_PLUGINS;

  it("reuses one list per rule configuration", () => {
    const rules = [rule("deploy")];
    const list = withChatHighlights(base, rules);
    expect(withChatHighlights(base, rules)).toBe(list);
    expect(withChatHighlights(base, [rule("deploy")])).toBe(list);
    expect(withChatHighlights(base, [rule("deploy", { color: "#ffffff" })])).not.toBe(list);
  });

  it("keeps the base list when no rule applies", () => {
    expect(withChatHighlights(base, [])).toBe(base);
    expect(withChatHighlights(base, [rule("deploy", { enabled: false })])).toBe(base);
  });
});
