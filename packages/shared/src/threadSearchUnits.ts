/**
 * Turns a thread's durable text into the units the sidebar search matches
 * against: its title, the URLs an assistant mentioned, and each user message.
 *
 * Matching a whole transcript makes every query hit everything, so assistant
 * prose is reduced to the URLs inside it — the part worth finding again — while
 * user messages stay whole because they are what a person remembers writing.
 *
 * @module threadSearchUnits
 */

/** What a unit came from, so results can be grouped and ranked by kind. */
export type ThreadSearchUnitKind = "title" | "url" | "user-message";

export interface ThreadSearchUnit {
  readonly kind: ThreadSearchUnitKind;
  readonly text: string;
  /** When the source message was written; absent for a title. */
  readonly createdAt: string | null;
}

/**
 * Bare `http(s)` runs, stopping before trailing punctuation that belongs to the
 * surrounding sentence rather than the link. Markdown link targets are covered
 * because the URL inside `](...)` still matches on its own.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/g;

/** Trailing characters a sentence leaves on a URL that is not part of it. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/** A URL long enough to be a real target rather than a bare origin fragment. */
const MIN_URL_LENGTH = 11;

/** Keeps one pathological message from flooding a thread's units. */
const MAX_URLS_PER_MESSAGE = 32;

/** Bounds a stored unit; a user message far longer than this is truncated. */
export const MAX_UNIT_TEXT_LENGTH = 2000;

/**
 * URLs an assistant mentioned, de-duplicated in first-seen order. Only what the
 * agent surfaced is worth indexing; a URL the user typed is already covered by
 * their message unit.
 */
export function extractUrls(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION, "");
    if (url.length < MIN_URL_LENGTH) continue;
    if (!seen.has(url)) seen.add(url);
    if (seen.size >= MAX_URLS_PER_MESSAGE) break;
  }
  return [...seen];
}

/**
 * Collapses whitespace runs so a stored unit is one line. Matching then never
 * has to reason about a newline sitting where the query has a space, and the
 * text doubles as the snippet the sidebar shows.
 */
function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_UNIT_TEXT_LENGTH
    ? collapsed.slice(0, MAX_UNIT_TEXT_LENGTH)
    : collapsed;
}

/**
 * Every unit for one thread. Messages arrive in the order they were written;
 * streaming messages are excluded by the caller, since a half-written message
 * would be indexed and then immediately stale.
 */
export function buildThreadSearchUnits(input: {
  readonly title: string;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly createdAt: string | null;
  }>;
}): readonly ThreadSearchUnit[] {
  const units: ThreadSearchUnit[] = [];
  const title = truncate(input.title);
  if (title.length > 0) units.push({ kind: "title", text: title, createdAt: null });

  const seenUrls = new Set<string>();
  for (const message of input.messages) {
    if (message.role === "user") {
      const text = truncate(message.text);
      if (text.length > 0) {
        units.push({ kind: "user-message", text, createdAt: message.createdAt });
      }
      continue;
    }
    // One row per URL, so a fuzzy match cannot run from a URL into the prose
    // around it or into the next link.
    for (const url of extractUrls(message.text)) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      units.push({ kind: "url", text: url, createdAt: message.createdAt });
    }
  }
  return units;
}
