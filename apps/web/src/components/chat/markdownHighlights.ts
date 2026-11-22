import { collectComposerModelMentions } from "@t3tools/client-runtime/composer-model-mentions";
import type { ChatHighlightRule } from "@t3tools/contracts";
import { matchInlineSkillTokens } from "@t3tools/shared/inlineSkills";
import { CHAT_MARKDOWN_ALLOWED_TAGS } from "@t3tools/shared/markdownHast";
import type { Root } from "hast";

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export interface CompiledHighlightRule {
  readonly regex: RegExp;
  readonly color: string;
}

export interface HighlightMatch {
  readonly start: number;
  readonly end: number;
  readonly rule: number;
}

/** Marks a highlight wrapper, so clipboard code can unwrap it. */
export const CHAT_HIGHLIGHT_ATTRIBUTE = "data-chat-highlight";

/** Bounds the elements one block can gain, so a rule matching every character stays cheap. */
export const MAX_HIGHLIGHT_MARKS_PER_BLOCK = 200;
/** Bounds the regex searches one block runs, whatever its rules and text. */
const MAX_HIGHLIGHT_SEARCHES_PER_BLOCK = 5000;

const WORD_START = /^[\p{L}\p{M}\p{N}_]/u;
const WORD_END = /[\p{L}\p{M}\p{N}_]$/u;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `\u{…}`, `\p{…}`, `\x41`, `\cA` and `\k<name>` are one atom each, never a quantifier. */
function escapeLength(source: string, index: number): number {
  const kind = source[index + 1];
  const through = (close: string) => {
    const end = source.indexOf(close, index + 2);
    return end < 0 ? 2 : end - index + 1;
  };
  if ((kind === "u" || kind === "p" || kind === "P") && source[index + 2] === "{") {
    return through("}");
  }
  if (kind === "k" && source[index + 2] === "<") return through(">");
  if (kind === "u") return 6;
  if (kind === "x") return 4;
  if (kind === "c") return 3;
  return 2;
}

/** Repetition counts, `?` does not: `(a|b)?` runs in linear time, `(a|b)+` may not. */
function quantifierAt(source: string, index: number) {
  const char = source[index];
  if (char === "*" || char === "+") return { length: 1, repeats: true };
  if (char === "?") return { length: 1, repeats: false };
  if (char !== "{") return null;
  const bounds = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(index));
  if (!bounds) return null;
  const max =
    bounds[2] === undefined ? Number(bounds[1]) : bounds[3] ? Number(bounds[3]) : Infinity;
  return { length: bounds[0].length, repeats: max > 1 };
}

/**
 * Whether a repeated group's body also repeats or alternates, as in `(a+)+`, `(a|aa)*` or
 * `(\w+\s?)*`. Such patterns can backtrack exponentially. Deliberately over-cautious.
 */
function hasNestedRepetition(source: string): boolean {
  // One flag per open group: its body holds a quantifier or an alternation.
  const open: boolean[] = [];
  const markOpenGroup = () => {
    if (open.length > 0) open[open.length - 1] = true;
  };
  let closedGroupVaries = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const afterVaryingGroup = closedGroupVaries;
    closedGroupVaries = false;
    const quantifier = quantifierAt(source, index);
    if (quantifier) {
      if (afterVaryingGroup && quantifier.repeats) return true;
      markOpenGroup();
      index += quantifier.length;
      if (source[index] === "?") index++;
      continue;
    }
    if (char === "\\") {
      index += escapeLength(source, index);
    } else if (char === "[") {
      // In `u` mode a `]` straight after `[` or `[^` closes the class: `[]` and `[^]`.
      index++;
      if (source[index] === "^") index++;
      while (index < source.length && source[index] !== "]") {
        index += source[index] === "\\" ? escapeLength(source, index) : 1;
      }
      index++;
    } else if (char === "(") {
      open.push(false);
      index++;
      if (source[index] !== "?") continue;
      index++;
      if (source[index] === "<" && source[index + 1] !== "=" && source[index + 1] !== "!") {
        while (index < source.length && source[index] !== ">") index++;
        index++;
      } else {
        index += source[index] === "<" ? 2 : 1;
      }
    } else if (char === ")") {
      closedGroupVaries = open.pop() ?? false;
      if (closedGroupVaries) markOpenGroup();
      index++;
    } else {
      if (char === "|") markOpenGroup();
      index++;
    }
  }
  return false;
}

export type HighlightRuleProblem = "invalid" | "slow";

function compiled(source: string): RegExp | null {
  try {
    return new RegExp(source, "giu");
  } catch {
    return null;
  }
}

export function highlightRuleProblem(
  rule: Pick<ChatHighlightRule, "pattern" | "regex">,
): HighlightRuleProblem | null {
  if (!rule.regex || rule.pattern.length === 0) return null;
  if (compiled(rule.pattern) === null) return "invalid";
  return hasNestedRepetition(rule.pattern) ? "slow" : null;
}

/** The rule's expression, or null when it is empty, does not compile, or may be too slow. */
export function highlightRuleRegex(rule: Pick<ChatHighlightRule, "pattern" | "regex">) {
  if (rule.regex) {
    if (rule.pattern.length === 0 || hasNestedRepetition(rule.pattern)) return null;
    return compiled(rule.pattern);
  }
  const phrase = rule.pattern.trim();
  if (phrase.length === 0) return null;
  const before = WORD_START.test(phrase) ? String.raw`(?<![\p{L}\p{M}\p{N}_])` : "";
  const after = WORD_END.test(phrase) ? String.raw`(?![\p{L}\p{M}\p{N}_])` : "";
  return compiled(`${before}${escapeRegExp(phrase)}${after}`);
}

export function compileHighlightRules(
  rules: ReadonlyArray<ChatHighlightRule>,
): CompiledHighlightRule[] {
  return rules.flatMap((rule) => {
    const regex = rule.enabled ? highlightRuleRegex(rule) : null;
    return regex ? [{ regex, color: rule.color }] : [];
  });
}

interface Range {
  start: number;
  end: number;
}

/** Skill and model chips are parsed from the rendered text, so a highlight inside one breaks it. */
function chipTokens(text: string): Range[] {
  const tokens = [
    ...[...matchInlineSkillTokens(text)].map(({ start, end }) => ({ start, end })),
    ...collectComposerModelMentions(text).map(({ start, end }) => ({ start, end })),
  ].toSorted((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const token of tokens) {
    const last = merged.at(-1);
    if (last && token.start <= last.end) last.end = Math.max(last.end, token.end);
    else merged.push({ ...token });
  }
  return merged;
}

const nextCodePoint = (text: string, index: number) =>
  index + ((text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1);

function trimmed(text: string, { start, end }: Range): Range | null {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

/** `range` minus the disjoint, sorted `tokens`, each piece trimmed. */
function withoutTokens(text: string, range: Range, tokens: ReadonlyArray<Range>): Range[] {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (tokens[middle]!.end <= range.start) low = middle + 1;
    else high = middle;
  }
  const pieces: Range[] = [];
  let start = range.start;
  for (let index = low; index < tokens.length && tokens[index]!.start < range.end; index++) {
    const token = tokens[index]!;
    if (token.start > start) pieces.push({ start, end: token.start });
    start = Math.max(start, token.end);
  }
  if (start < range.end) pieces.push({ start, end: range.end });
  return pieces.flatMap((piece) => trimmed(text, piece) ?? []);
}

/** Searches left for one block; shared across its runs. */
export interface HighlightScanBudget {
  searches: number;
}

/**
 * Highlighted ranges in order. From each position the match that starts first wins, the
 * earlier rule on a tie, and scanning resumes where it ends. At most `limit` ranges.
 */
export function findHighlightMatches(
  text: string,
  rules: ReadonlyArray<CompiledHighlightRule>,
  limit = Number.POSITIVE_INFINITY,
  budget: HighlightScanBudget = { searches: Number.POSITIVE_INFINITY },
): HighlightMatch[] {
  const tokens = chipTokens(text);
  const search = (rule: number, from: number): Range | null => {
    const { regex } = rules[rule]!;
    // Every retry moves past a whole code point: `lastIndex` inside a surrogate pair makes a
    // `u` regex start at the pair again.
    for (let at = from; at <= text.length && budget.searches > 0;) {
      budget.searches--;
      regex.lastIndex = at;
      const match = regex.exec(text);
      if (!match) return null;
      const end = match.index + match[0].length;
      const range = trimmed(text, { start: match.index, end });
      if (range) return range;
      at = Math.max(end, nextCodePoint(text, match.index));
    }
    return null;
  };
  // Each rule's earliest match at or after `position`; null once it has none left.
  const next: Array<Range | null | undefined> = rules.map(() => undefined);
  const matches: HighlightMatch[] = [];
  let position = 0;
  while (matches.length < limit && budget.searches > 0) {
    let best = -1;
    for (let rule = 0; rule < rules.length; rule++) {
      let candidate = next[rule];
      if (candidate === null) continue;
      if (candidate === undefined || candidate.start < position) {
        candidate = next[rule] = search(rule, position);
      }
      if (candidate && (best < 0 || candidate.start < next[best]!.start)) best = rule;
    }
    if (best < 0) break;
    const match = next[best]!;
    const pieces = withoutTokens(text, match, tokens);
    if (pieces.length === 0) {
      next[best] = search(best, nextCodePoint(text, match.start));
      continue;
    }
    for (const piece of pieces.slice(0, limit - matches.length)) {
      matches.push({ ...piece, rule: best });
    }
    position = match.end;
  }
  return matches;
}

// Plain quotes hold the user's own words; callouts (alerts, insights) are the agent's.
const SKIPPED_TAGS = new Set([
  "a",
  "code",
  "kbd",
  "mark",
  "pre",
  "samp",
  "script",
  "style",
  "svg",
  "tt",
]);
const skipsHighlights = (node: HastNode) =>
  SKIPPED_TAGS.has(node.tagName ?? "") ||
  (node.tagName === "blockquote" && node.properties?.["dataAlert"] === undefined);

const BREAK_TAGS = new Set([
  "blockquote",
  "br",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "picture",
  "rp",
  "rt",
  "ruby",
  "section",
  "source",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
// Every other element the sanitizer allows is phrasing, so `not **pushed**` reads as one phrase.
// `span` also comes from plugins that run after sanitizing.
const INLINE_TAGS = new Set(
  [...CHAT_MARKDOWN_ALLOWED_TAGS, "span"].filter(
    (tag) => !BREAK_TAGS.has(tag) && !SKIPPED_TAGS.has(tag),
  ),
);

interface TextRun {
  readonly block: HastNode;
  readonly nodes: HastNode[];
  readonly starts: number[];
  text: string;
}

interface Wrap {
  readonly start: number;
  readonly end: number;
  readonly color: string;
}

function wrapText(node: HastNode, wraps: ReadonlyArray<Wrap>): HastNode[] {
  const value = node.value ?? "";
  const parts: HastNode[] = [];
  let offset = 0;
  for (const { start, end, color } of wraps) {
    if (start > offset) parts.push({ type: "text", value: value.slice(offset, start) });
    parts.push({
      type: "element",
      tagName: "mark",
      properties: {
        className: ["chat-highlight"],
        [CHAT_HIGHLIGHT_ATTRIBUTE]: "",
        style: `--chat-highlight:${color}`,
      },
      children: [{ type: "text", value: value.slice(start, end) }],
    });
    offset = end;
  }
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

function replaceWrapped(node: HastNode, wraps: ReadonlyMap<HastNode, Wrap[]>): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    const childWraps = wraps.get(child);
    if (childWraps) return wrapText(child, childWraps);
    replaceWrapped(child, wraps);
    return [child];
  });
}

/**
 * Wraps rule matches in prose. Text joins across inline elements within a block; code, links,
 * plain quotes and block boundaries end it. Runs after sanitizing, so its attributes survive.
 */
function rehypeChatHighlights(options: { rules: ReadonlyArray<CompiledHighlightRule> }) {
  const { rules } = options;
  return (tree: HastNode) => {
    const wraps = new Map<HastNode, Wrap[]>();
    const budgets = new Map<HastNode, { marks: number; scan: HighlightScanBudget }>();
    let run: TextRun | null = null;
    const flush = () => {
      if (run === null) return;
      const { block, nodes, starts, text } = run;
      run = null;
      let budget = budgets.get(block);
      if (!budget) {
        budget = {
          marks: MAX_HIGHLIGHT_MARKS_PER_BLOCK,
          scan: { searches: MAX_HIGHLIGHT_SEARCHES_PER_BLOCK },
        };
        budgets.set(block, budget);
      }
      let used = 0;
      let first = 0;
      for (const match of findHighlightMatches(text, rules, budget.marks, budget.scan)) {
        while (
          first < nodes.length &&
          starts[first]! + nodes[first]!.value!.length <= match.start
        ) {
          first++;
        }
        for (let index = first; index < nodes.length && starts[index]! < match.end; index++) {
          const offset = starts[index]!;
          const start = Math.max(match.start, offset) - offset;
          const end = Math.min(match.end, offset + nodes[index]!.value!.length) - offset;
          if (end <= start) continue;
          if (used === budget.marks) break;
          const list = wraps.get(nodes[index]!) ?? [];
          list.push({ start, end, color: rules[match.rule]!.color });
          wraps.set(nodes[index]!, list);
          used++;
        }
      }
      budget.marks -= used;
    };
    const visit = (node: HastNode, block: HastNode) => {
      for (const child of node.children ?? []) {
        if (child.type === "text") {
          run ??= { block, nodes: [], starts: [], text: "" };
          child.value ??= "";
          run.nodes.push(child);
          run.starts.push(run.text.length);
          run.text += child.value;
        } else if (child.type === "element" && INLINE_TAGS.has(child.tagName ?? "")) {
          visit(child, block);
        } else {
          flush();
          if (child.type === "element" && !skipsHighlights(child)) visit(child, child);
          flush();
        }
      }
    };
    visit(tree, tree);
    flush();
    if (wraps.size > 0) replaceWrapped(tree, wraps);
  };
}

/** Marks rule matches in a rendered chat tree. */
export type ChatHighlighter = (tree: Root) => void;

interface HighlightConfig {
  readonly highlight: ChatHighlighter | undefined;
}

const configsBySettings = new WeakMap<ReadonlyArray<ChatHighlightRule>, HighlightConfig>();
// Equal rules decoded anew (another tab, a reset) keep the same renderer and its parse cache.
const MAX_RECENT_CONFIGS = 8;
const configsByKey = new Map<string, HighlightConfig>();

function configFor(settings: ReadonlyArray<ChatHighlightRule>): HighlightConfig {
  const known = configsBySettings.get(settings);
  if (known) return known;
  const enabled = settings.filter((rule) => rule.enabled);
  const key = JSON.stringify(enabled.map((rule) => [rule.pattern, rule.regex, rule.color]));
  let config = configsByKey.get(key);
  if (config) {
    configsByKey.delete(key);
  } else {
    const rules = compileHighlightRules(enabled);
    const run = rules.length === 0 ? undefined : rehypeChatHighlights({ rules });
    config = { highlight: run && ((tree) => run(tree as HastNode)) };
    if (configsByKey.size >= MAX_RECENT_CONFIGS) {
      configsByKey.delete(configsByKey.keys().next().value!);
    }
  }
  configsByKey.set(key, config);
  configsBySettings.set(settings, config);
  return config;
}

/**
 * One stable highlighter per rule configuration, so each configuration gets one renderer and an
 * unchanged one keeps its parse cache. Undefined when no rule applies.
 */
export function chatHighlighter(
  settings: ReadonlyArray<ChatHighlightRule>,
): ChatHighlighter | undefined {
  return settings.length === 0 ? undefined : configFor(settings).highlight;
}
