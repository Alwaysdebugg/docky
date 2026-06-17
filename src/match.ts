/**
 * Pure, dependency-free fuzzy matching for the quick-open palette (F02).
 *
 * Case-insensitive subsequence matching with light ranking: contiguous runs,
 * word boundaries, and a prefix match all score higher; shorter targets win
 * ties. Works for both ASCII and CJK because it compares whole characters.
 *
 * Kept pure (no Ink/fs) so it is trivially unit-testable.
 */

const WORD_BOUNDARY = /[\s\-_/.·:]/;

/**
 * Score how well `query` fuzzy-matches `text` as a subsequence.
 * Returns a number (higher = better) or `null` when `text` does not contain
 * every character of `query` in order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  let ti = 0;
  let score = 0;
  let prev = -2;
  let streak = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === ch) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;

    score += 1; // base point per matched char
    if (found === prev + 1) {
      streak += 1;
      score += 2 + streak; // reward contiguous runs, growing
    } else {
      streak = 0;
    }
    if (found === 0) score += 4; // matches at the very start
    else if (WORD_BOUNDARY.test(t[found - 1])) score += 3; // word-start match

    prev = found;
    ti = found + 1;
  }

  // Tie-breaker: prefer tighter (shorter) targets.
  return score - t.length * 0.01;
}

/**
 * Filter and rank `items` by how well they fuzzy-match `query`.
 * `toText` extracts the searchable string from each item. An empty/whitespace
 * query returns the items unchanged (preserving caller order).
 */
export function fuzzy<T>(query: string, items: T[], toText: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  const scored: Array<{ item: T; score: number; idx: number }> = [];
  items.forEach((item, idx) => {
    const s = fuzzyScore(query, toText(item));
    if (s !== null) scored.push({ item, score: s, idx });
  });
  // Higher score first; stable on ties via original index.
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.item);
}
