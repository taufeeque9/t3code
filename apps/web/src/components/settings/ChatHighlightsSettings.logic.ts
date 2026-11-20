import type { ChatHighlightRule } from "@t3tools/contracts";

/** `rules` with one rule changed by id, or null when it is gone (removed, or the list reset). */
export function withRulePatch(
  rules: ReadonlyArray<ChatHighlightRule>,
  id: string,
  patch: Partial<ChatHighlightRule>,
): ReadonlyArray<ChatHighlightRule> | null {
  if (!rules.some((rule) => rule.id === id)) return null;
  return rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule));
}
