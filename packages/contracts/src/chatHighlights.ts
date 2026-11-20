import * as Schema from "effect/Schema";

export const MAX_CHAT_HIGHLIGHT_RULES = 50;
export const MAX_CHAT_HIGHLIGHT_PATTERN_LENGTH = 500;

export const ChatHighlightColor = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));

/** A phrase matches case-insensitively as whole words; `regex` reads `pattern` as a JavaScript regular expression. */
export const ChatHighlightRule = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  label: Schema.String.check(Schema.isMaxLength(80)),
  pattern: Schema.String.check(Schema.isMaxLength(MAX_CHAT_HIGHLIGHT_PATTERN_LENGTH)),
  regex: Schema.Boolean,
  color: ChatHighlightColor,
  enabled: Schema.Boolean,
});
export type ChatHighlightRule = typeof ChatHighlightRule.Type;

export const ChatHighlightRules = Schema.Array(ChatHighlightRule).check(
  Schema.isMaxLength(MAX_CHAT_HIGHLIGHT_RULES),
);
export type ChatHighlightRules = typeof ChatHighlightRules.Type;

const AMBER = "#f59e0b";
const BLUE = "#3b82f6";
const PURPLE = "#a855f7";
const GREEN = "#22c55e";
const RED = "#ef4444";

const negated = (alternation: string) =>
  String.raw`(?<!\b(?:no|not|nothing|never|zero|without)\s)(?:${alternation})`;

const regexRule = (id: string, label: string, color: string, pattern: string) =>
  ({ id, label, pattern, regex: true, color, enabled: true }) satisfies ChatHighlightRule;

/** Where matches overlap the earliest start wins, and an earlier rule breaks a tie. */
export const DEFAULT_CHAT_HIGHLIGHT_RULES: ChatHighlightRules = [
  regexRule(
    "permission-ask",
    "Permission ask",
    AMBER,
    String.raw`\b(?:may|can|shall|should) I (?:create|merge|push|launch|delete|run|apply|proceed|start|relaunch|cancel|deploy|install)\b`,
  ),
  { id: "offer", label: "Offer", pattern: "want me to", regex: false, color: AMBER, enabled: true },
  regexRule(
    "waiting-on-you",
    "Waiting on you",
    AMBER,
    String.raw`\b(?:needs?|waits? on|awaiting) your\b|\bup to you\b|\bif you say go\b|\bon your (?:go|ok)\b`,
  ),
  regexRule(
    "your-decision",
    "Your decision",
    AMBER,
    String.raw`\byour (?:decision|call|choice)\b|\bdecisions? (?:is |are )?yours\b|\bdecisions? for you\b|\byours to (?:make|decide)\b|\bfor you to (?:check|decide|confirm|review|answer)\b`,
  ),
  regexRule(
    "open-decision",
    "Open decision",
    AMBER,
    negated(String.raw`\b(?:pending|open|remaining) decisions?\b`),
  ),
  regexRule(
    "question",
    "Question",
    BLUE,
    String.raw`(?<=^|[.!?\n:]\s*)[^.!?\n:\s][^.!?\n:]*\?(?=\s|$)`,
  ),
  regexRule(
    "open-question",
    "Open question",
    BLUE,
    negated(
      String.raw`\b(?:open|remaining|pending|outstanding) questions?\b|\bquestions? for you\b`,
    ),
  ),
  regexRule(
    "not-done",
    "Not done",
    PURPLE,
    String.raw`\bnot (?:yet )?(?:pushed|committed|merged|deployed|installed|verified|tested|checked)\b|\b(?:haven't|have not|didn't|did not) (?:verif(?:y|ied)|check(?:ed)?|test(?:ed)?|push(?:ed)?|commit(?:ted)?|deploy(?:ed)?|rebuil[dt]|install(?:ed)?|restart(?:ed)?|launch(?:ed)?)\b|\bstill local\b|\b(?:uncommitted|unpushed)\b`,
  ),
  regexRule("unverified", "Unverified", PURPLE, negated(String.raw`\b(?:unverified|untested)\b`)),
  regexRule(
    "action-taken",
    "Action taken",
    GREEN,
    negated(
      String.raw`\b(?:pushed|committed|merged|deployed|promoted|published|released|launched|submitted|relaunched|installed)\b`,
    ),
  ),
  regexRule(
    "destructive",
    "Destructive",
    RED,
    negated(String.raw`\b(?:deleted|killed|cancell?ed|force[- ]pushed|dropped)\b`),
  ),
  regexRule(
    "correction",
    "Correction",
    RED,
    String.raw`\b(?:correction|I was wrong|I misstated|retract(?:ed)?)\b`,
  ),
  regexRule(
    "failure",
    "Failure",
    RED,
    negated(String.raw`\b(?:OOM|out of memory|crash(?:ed|es)?|timed out)\b|\bblocked on\b`),
  ),
];
