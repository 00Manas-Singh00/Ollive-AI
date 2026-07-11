// Dependency-free subsequence fuzzy matcher (Phase 24).
// Scores consecutive character runs and word-start hits higher; returns
// matched character indices so the UI can highlight them.

export type FuzzyMatch = {
  score: number;
  indices: number[];
};

const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 10;
const FIRST_CHAR_BONUS = 12;
const GAP_PENALTY = 1;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  return prev === " " || prev === "-" || prev === "_" || prev === "/" || prev === ".";
}

/** Match `query` as a case-insensitive subsequence of `text`. Null when it doesn't match. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, indices: [] };

  const indices: number[] = [];
  let score = 0;
  let ti = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;

    if (found === 0) score += FIRST_CHAR_BONUS;
    if (isWordStart(text, found)) score += WORD_START_BONUS;
    if (indices.length && found === indices[indices.length - 1] + 1) score += CONSECUTIVE_BONUS;
    score -= (found - ti) * GAP_PENALTY;

    indices.push(found);
    ti = found + 1;
  }

  // Shorter targets rank higher on equal character scores.
  score -= Math.floor(text.length / 10);
  return { score, indices };
}

export type FuzzyResult<T> = { item: T; score: number; indices: number[] };

/** Filter + rank `items` by fuzzy-matching `query` against `getText(item)`. */
export function fuzzyFilter<T>(query: string, items: T[], getText: (item: T) => string): FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, getText(item));
    if (match) results.push({ item, score: match.score, indices: match.indices });
  }
  return results.sort((a, b) => b.score - a.score);
}
