import type { ChatHighlightRule } from "@t3tools/contracts";
import type { PluggableList } from "unified";

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

const WORD_START = /^[\p{L}\p{M}\p{N}_]/u;
const WORD_END = /[\p{L}\p{M}\p{N}_]$/u;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

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
      index += 2;
    } else if (char === "[") {
      index++;
      if (source[index] === "^") index++;
      if (source[index] === "]") index++;
      while (index < source.length && source[index] !== "]") {
        index += source[index] === "\\" ? 2 : 1;
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

// Skill chips (`$deploy`) and mentions (`@name`, `model:a/b`) are parsed from the rendered text,
// so a highlight inside one would break the chip.
const PROTECTED_TOKEN = /(?<!\S)(?:[\p{Sc}@][\p{L}\p{N}][\p{L}\p{N}:_./-]*|model:\S+)/gu;

interface Range {
  start: number;
  end: number;
}

function trimmed(text: string, { start, end }: Range): Range | null {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

function withoutTokens(text: string, range: Range, tokens: ReadonlyArray<Range>): Range[] {
  const pieces: Range[] = [];
  let start = range.start;
  for (const token of tokens) {
    if (token.end <= start) continue;
    if (token.start >= range.end) break;
    if (token.start > start) pieces.push({ start, end: token.start });
    start = Math.max(start, token.end);
  }
  if (start < range.end) pieces.push({ start, end: range.end });
  return pieces.flatMap((piece) => trimmed(text, piece) ?? []);
}

/**
 * Highlighted ranges in order. From each position the match that starts first wins, the
 * earlier rule on a tie, and scanning resumes where it ends. At most `limit` ranges.
 */
export function findHighlightMatches(
  text: string,
  rules: ReadonlyArray<CompiledHighlightRule>,
  limit = Number.POSITIVE_INFINITY,
): HighlightMatch[] {
  const tokens = [...text.matchAll(PROTECTED_TOKEN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const search = (rule: number, from: number): Range | null => {
    const { regex } = rules[rule]!;
    for (let at = from; at <= text.length;) {
      regex.lastIndex = at;
      const match = regex.exec(text);
      if (!match) return null;
      const range = trimmed(text, { start: match.index, end: match.index + match[0].length });
      if (range) return range;
      at = match.index + 1;
    }
    return null;
  };
  // Each rule's earliest match at or after `position`; null once it has none left.
  const next: Array<Range | null | undefined> = rules.map(() => undefined);
  const matches: HighlightMatch[] = [];
  let position = 0;
  while (matches.length < limit) {
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
      next[best] = search(best, match.start + 1);
      continue;
    }
    for (const piece of pieces.slice(0, limit - matches.length)) {
      matches.push({ ...piece, rule: best });
    }
    position = match.end;
  }
  return matches;
}

// Matches span these, so `not **pushed**` reads as one phrase. Anything else breaks a run.
const INLINE_TAGS = new Set([
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "q",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
]);

// Plain quotes hold the user's own words; callouts (alerts, insights) are the agent's.
function skipsHighlights(node: HastNode): boolean {
  switch (node.tagName) {
    case "a":
    case "code":
    case "kbd":
    case "mark":
    case "pre":
    case "samp":
    case "script":
    case "style":
    case "svg":
      return true;
    case "blockquote":
      return node.properties?.["dataAlert"] === undefined;
    default:
      return false;
  }
}

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
    const budgets = new Map<HastNode, number>();
    let run: TextRun | null = null;
    const flush = () => {
      if (run === null) return;
      const { block, nodes, starts, text } = run;
      run = null;
      const budget = budgets.get(block) ?? MAX_HIGHLIGHT_MARKS_PER_BLOCK;
      let used = 0;
      let first = 0;
      for (const match of findHighlightMatches(text, rules, budget)) {
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
          if (used === budget) break;
          const list = wraps.get(nodes[index]!) ?? [];
          list.push({ start, end, color: rules[match.rule]!.color });
          wraps.set(nodes[index]!, list);
          used++;
        }
      }
      budgets.set(block, budget - used);
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

interface HighlightPluginLists {
  readonly byBase: WeakMap<PluggableList, PluggableList>;
  readonly rules: ReadonlyArray<CompiledHighlightRule>;
}

const listsBySettings = new WeakMap<ReadonlyArray<ChatHighlightRule>, HighlightPluginLists>();
// Equal rules decoded anew (another tab, a reset) keep the same renderer and its parse cache.
const MAX_RECENT_CONFIGS = 8;
const listsByKey = new Map<string, HighlightPluginLists>();

function pluginListsFor(settings: ReadonlyArray<ChatHighlightRule>): HighlightPluginLists {
  const known = listsBySettings.get(settings);
  if (known) return known;
  const enabled = settings.filter((rule) => rule.enabled);
  const key = JSON.stringify(enabled.map((rule) => [rule.pattern, rule.regex, rule.color]));
  let lists = listsByKey.get(key);
  if (lists) {
    listsByKey.delete(key);
  } else {
    lists = { byBase: new WeakMap(), rules: compileHighlightRules(enabled) };
    if (listsByKey.size >= MAX_RECENT_CONFIGS) {
      listsByKey.delete(listsByKey.keys().next().value!);
    }
  }
  listsByKey.set(key, lists);
  listsBySettings.set(settings, lists);
  return lists;
}

/**
 * `base` with the highlight plugin appended, one stable list per rule configuration, so each
 * configuration gets one renderer and an unchanged one keeps its parse cache.
 */
export function withChatHighlights(
  base: PluggableList,
  settings: ReadonlyArray<ChatHighlightRule>,
): PluggableList {
  if (settings.length === 0) return base;
  const lists = pluginListsFor(settings);
  if (lists.rules.length === 0) return base;
  let combined = lists.byBase.get(base);
  if (!combined) {
    combined = [...base, [rehypeChatHighlights, { rules: lists.rules }]];
    lists.byBase.set(base, combined);
  }
  return combined;
}
