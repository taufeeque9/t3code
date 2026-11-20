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

/** Marks a highlight wrapper, so clipboard HTML can unwrap it. */
export const CHAT_HIGHLIGHT_ATTRIBUTE = "data-chat-highlight";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The rule's expression, or null when it is empty or does not compile. */
export function highlightRuleRegex(rule: Pick<ChatHighlightRule, "pattern" | "regex">) {
  const pattern = rule.regex ? rule.pattern : rule.pattern.trim();
  if (pattern.length === 0) return null;
  const source = rule.regex
    ? pattern
    : `${/^\w/.test(pattern) ? "\\b" : ""}${escapeRegExp(pattern)}${/\w$/.test(pattern) ? "\\b" : ""}`;
  try {
    return new RegExp(source, "giu");
  } catch {
    return null;
  }
}

export function compileHighlightRules(
  rules: ReadonlyArray<ChatHighlightRule>,
): CompiledHighlightRule[] {
  return rules.flatMap((rule) => {
    const regex = rule.enabled ? highlightRuleRegex(rule) : null;
    return regex ? [{ regex, color: rule.color }] : [];
  });
}

/** Non-overlapping matches in order. The earliest start wins, then the earlier rule. */
export function findHighlightMatches(
  text: string,
  rules: ReadonlyArray<CompiledHighlightRule>,
): HighlightMatch[] {
  const candidates: HighlightMatch[] = [];
  rules.forEach(({ regex }, rule) => {
    for (const match of text.matchAll(regex)) {
      let start = match.index;
      let end = start + match[0].length;
      while (start < end && /\s/u.test(text[start]!)) start++;
      while (end > start && /\s/u.test(text[end - 1]!)) end--;
      if (end > start) candidates.push({ start, end, rule });
    }
  });
  candidates.sort((left, right) => left.start - right.start || left.rule - right.rule);
  const matches: HighlightMatch[] = [];
  let covered = 0;
  for (const candidate of candidates) {
    if (candidate.start < covered) continue;
    matches.push(candidate);
    covered = candidate.end;
  }
  return matches;
}

// Plain quotes hold the user's own words; callouts (alerts, insights) are the agent's.
function skipsHighlights(node: HastNode): boolean {
  switch (node.tagName) {
    case "a":
    case "code":
    case "kbd":
    case "mark":
    case "pre":
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

function highlightText(
  node: HastNode,
  rules: ReadonlyArray<CompiledHighlightRule>,
): HastNode[] | null {
  const value = node.value ?? "";
  const matches = findHighlightMatches(value, rules);
  if (matches.length === 0) return null;
  const parts: HastNode[] = [];
  let offset = 0;
  for (const { start, end, rule } of matches) {
    if (start > offset) parts.push({ type: "text", value: value.slice(offset, start) });
    parts.push({
      type: "element",
      tagName: "mark",
      properties: {
        className: ["chat-highlight"],
        [CHAT_HIGHLIGHT_ATTRIBUTE]: "",
        style: `--chat-highlight:${rules[rule]!.color}`,
      },
      children: [{ type: "text", value: value.slice(start, end) }],
    });
    offset = end;
  }
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

/** Wraps rule matches in prose text. Runs after sanitizing, so its attributes survive. */
function rehypeChatHighlights(options: { rules: ReadonlyArray<CompiledHighlightRule> }) {
  const visit = (node: HastNode): void => {
    if (!node.children || skipsHighlights(node)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return highlightText(child, options.rules) ?? [child];
      visit(child);
      return [child];
    });
  };
  return visit;
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
