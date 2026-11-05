// Ranks the model picker's rows against a search, ported from T3 Code's modelPickerSearch.ts and the parts of its
// searchRanking.ts it uses (MIT, see NOTICE). Lower scores rank first; null means the row doesn't match.

export interface ModelPickerSearchable {
  /** The row's name, as shown. */
  name: string;
  /** What the row saves (a model id), when it differs from the name. */
  value?: string | undefined;
  /** A second line or note, such as "Claude Code" or a tier's description. */
  detail?: string | undefined;
  /** The provider's name, so "codex" finds Codex's models. */
  providerName: string;
  isFavorite?: boolean;
}

const FAVORITE_SCORE_BOOST = 24;
const EXACT_NAME_SCORE = -1000;

export const normalizeSearchQuery = (input: string): string => input.trim().toLowerCase();

const normalizeName = (name: string): string => normalizeSearchQuery(name).replace(/\s+/gu, " ");

/** How closely the query's letters appear in order in the value, gaps costing most; null when they don't all. */
function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) return gapPenalty * 3 + (valueIndex - firstMatchIndex + 1 - query.length);
  }
  return null;
}

const BOUNDARY_MARKERS = [" ", "-", "_", "/", ".", ":"];

/** One token against one field: exact, prefix, after a word boundary, anywhere, then (3+ letters) in order. */
function scoreToken(field: string, token: string, base: number): number | null {
  if (!field || !token) return null;
  if (field === token) return base;
  if (field.startsWith(token)) return base + 2;
  if (BOUNDARY_MARKERS.some((marker) => field.includes(`${marker}${token}`))) return base + 4;
  if (field.includes(token)) return base + 6;
  if (token.length >= 3) {
    const fuzzy = scoreSubsequenceMatch(field, token);
    if (fuzzy !== null) return base + 100 + fuzzy;
  }
  return null;
}

function searchFields(row: ModelPickerSearchable): string[] {
  const parts = [row.name, row.value, row.detail, row.providerName].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  // Earlier fields weigh more: a name match beats a provider match.
  return [...parts.map(normalizeSearchQuery), normalizeSearchQuery(parts.join(" "))];
}

/**
 * A row's score for the query: every token has to match some field, and the row scores the sum of each token's best.
 * A query that is exactly the row's name or value wins outright. An empty query matches everything at 0.
 */
export function scoreModelPickerSearch(row: ModelPickerSearchable, query: string): number | null {
  const tokens = normalizeSearchQuery(query)
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return 0;
  const normalized = tokens.join(" ");
  if (normalized === normalizeName(row.name) || (row.value && normalized === normalizeName(row.value))) {
    return EXACT_NAME_SCORE;
  }
  const fields = searchFields(row);
  let score = 0;
  for (const token of tokens) {
    let best: number | null = null;
    fields.forEach((field, index) => {
      const fieldScore = scoreToken(field, token, index * 10);
      if (fieldScore !== null && (best === null || fieldScore < best)) best = fieldScore;
    });
    if (best === null) return null;
    score += best;
  }
  return row.isFavorite ? score - FAVORITE_SCORE_BOOST : score;
}

/** The items that match, best first; ties keep favorites first, then the order given. */
export function rankModelPickerSearch<T>(
  items: ReadonlyArray<T>,
  query: string,
  toSearchable: (item: T) => ModelPickerSearchable,
): T[] {
  const ranked: Array<{ item: T; score: number; isFavorite: boolean; order: number }> = [];
  items.forEach((item, order) => {
    const searchable = toSearchable(item);
    const score = scoreModelPickerSearch(searchable, query);
    if (score !== null) ranked.push({ item, score, isFavorite: searchable.isFavorite === true, order });
  });
  return ranked
    .toSorted((a, b) => a.score - b.score || Number(b.isFavorite) - Number(a.isFavorite) || a.order - b.order)
    .map((entry) => entry.item);
}
