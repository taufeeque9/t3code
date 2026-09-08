/**
 * Subsequence fuzzy matching for the sidebar search.
 *
 * Scoring rewards the matches a person expects at the top: a contiguous run
 * beats a scattered one, a hit at a word boundary beats a hit inside a word,
 * and an early hit beats a late one. A match is always confined to the single
 * unit it scored against, so nothing can match across two messages.
 *
 * @module fuzzyMatch
 */

/** Beyond this a candidate is not worth scanning character by character. */
const MAX_SCORED_LENGTH = 2000;

/** Consecutive matched characters are what make a match feel exact. */
const ADJACENCY_BONUS = 8;

/** A hit right after a separator is the start of a word the user meant. */
const WORD_BOUNDARY_BONUS = 10;

/** Matching the very first character is the strongest signal of intent. */
const PREFIX_BONUS = 12;

/** Each unmatched character before the first hit costs a little. */
const LEADING_GAP_PENALTY = 1;

/** Cap on the leading-gap penalty, so a long candidate is not doomed. */
const MAX_LEADING_GAP_PENALTY = 20;

/** An exact substring hit outranks any scattered subsequence. */
const CONTIGUOUS_BONUS = 40;

export interface FuzzyMatchResult {
  readonly score: number;
  /** Indices in the candidate that matched, ascending; empty for no match. */
  readonly matchedIndices: readonly number[];
}

const NO_MATCH: FuzzyMatchResult = { score: 0, matchedIndices: [] };

function isWordBoundary(previous: string | undefined): boolean {
  if (previous === undefined) return true;
  return !/[A-Za-z0-9]/.test(previous);
}

/**
 * Scores `query` against `candidate`, returning 0 when the query's characters
 * do not appear in order. Case-insensitive. Candidates are the
 * whitespace-collapsed unit texts written by `threadSearchUnits`.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatchResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) return NO_MATCH;
  if (candidate.length === 0 || candidate.length > MAX_SCORED_LENGTH) return NO_MATCH;
  const normalizedCandidate = candidate.toLowerCase();

  // A direct substring is both the common case and the best one, so it is
  // answered without the subsequence walk.
  const directIndex = normalizedCandidate.indexOf(normalizedQuery);
  if (directIndex !== -1) {
    const indices: number[] = [];
    for (let offset = 0; offset < normalizedQuery.length; offset += 1) {
      indices.push(directIndex + offset);
    }
    let score = CONTIGUOUS_BONUS + normalizedQuery.length * ADJACENCY_BONUS;
    if (directIndex === 0) score += PREFIX_BONUS;
    if (isWordBoundary(normalizedCandidate[directIndex - 1])) score += WORD_BOUNDARY_BONUS;
    score -= Math.min(directIndex * LEADING_GAP_PENALTY, MAX_LEADING_GAP_PENALTY);
    return { score: Math.max(1, score), matchedIndices: indices };
  }

  const matchedIndices: number[] = [];
  let score = 0;
  let candidateIndex = 0;
  let previousMatchIndex = -1;
  for (const queryChar of normalizedQuery) {
    // A space in the query can only be satisfied by a space, so a two-word
    // query cannot collapse into the middle of one long word. Units are stored
    // whitespace-collapsed, so that space is the only form it can take.
    const found = normalizedCandidate.indexOf(queryChar, candidateIndex);
    if (found === -1) return NO_MATCH;
    matchedIndices.push(found);
    if (found === previousMatchIndex + 1) {
      score += ADJACENCY_BONUS;
    } else if (isWordBoundary(normalizedCandidate[found - 1])) {
      score += WORD_BOUNDARY_BONUS;
    } else {
      score += 1;
    }
    if (found === 0) score += PREFIX_BONUS;
    previousMatchIndex = found;
    candidateIndex = found + 1;
  }
  const firstIndex = matchedIndices[0] ?? 0;
  score -= Math.min(firstIndex * LEADING_GAP_PENALTY, MAX_LEADING_GAP_PENALTY);
  return { score: Math.max(1, score), matchedIndices };
}
