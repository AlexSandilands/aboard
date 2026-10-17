// Settings search: case-insensitive matching over the settings index, title first. Every word typed has to match
// something in the entry; the entry ranks by its worst-matching word, so "quiet hours" finds the setting of that
// name above one that merely mentions them.
import type { SettingsAskEntry } from "@repo/contracts";
import { settingsLocation, type SettingsIndexEntry } from "./settingsIndex.logic";

/** Best (lowest) first. */
const RANK = {
  titleExact: 0,
  titlePrefix: 1,
  titleWord: 2,
  titleContains: 3,
  keyword: 4,
  location: 5,
  description: 6,
} as const;

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Where a word sits in a title: the whole title, its start, the start of one of its words, or anywhere in it. */
function titleRank(title: string, word: string): number | null {
  if (title === word) return RANK.titleExact;
  if (title.startsWith(word)) return RANK.titlePrefix;
  if (title.includes(` ${word}`) || title.includes(`-${word}`)) return RANK.titleWord;
  return title.includes(word) ? RANK.titleContains : null;
}

function wordRank(entry: SettingsIndexEntry, word: string): number | null {
  const title = titleRank(normalize(entry.title), word);
  if (title !== null) return title;
  if (entry.keywords.some((keyword) => normalize(keyword).includes(word))) return RANK.keyword;
  if (normalize(`${entry.groupLabel} ${entry.sectionLabel}`).includes(word)) return RANK.location;
  return normalize(entry.description).includes(word) ? RANK.description : null;
}

/**
 * The entries matching `query`, best first; ties keep page order. An empty query matches nothing: the caller shows
 * the list instead. A sub-section's own entry sorts after a row of the same rank, so a row isn't buried under it.
 */
export function searchSettings(
  entries: ReadonlyArray<SettingsIndexEntry>,
  query: string,
  limit = 30,
): SettingsIndexEntry[] {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const matches: { entry: SettingsIndexEntry; rank: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    let rank = 0;
    for (const word of words) {
      const wordMatch = wordRank(entry, word);
      if (wordMatch === null) return;
      rank = Math.max(rank, wordMatch);
    }
    // The words together may be the title, or start it: "quiet hours" is the setting of that name, not one that
    // happens to have both words somewhere in its title.
    if (words.length > 1) rank = Math.min(rank, titleRank(normalize(entry.title), words.join(" ")) ?? rank);
    matches.push({ entry, rank, order });
  });
  matches.sort((a, b) => a.rank - b.rank || kindOrder(a.entry) - kindOrder(b.entry) || a.order - b.order);
  return matches.slice(0, limit).map((match) => match.entry);
}

const kindOrder = (entry: SettingsIndexEntry) => (entry.kind === "section" ? 1 : 0);

/** What `/` and Ctrl/Cmd+F do on the settings page: focus the search box instead of the browser's own. */
export function isSearchShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (event.altKey || event.shiftKey) return false;
  const key = event.key.toLowerCase();
  if (key === "/") return !event.ctrlKey && !event.metaKey;
  return key === "f" && (event.ctrlKey || event.metaKey) && !(event.ctrlKey && event.metaKey);
}

/** Moves the highlighted result by one, wrapping at the ends; `count` 0 has none. */
export function moveResult(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** Words a question starts with ("how do I…", "where can I…"); a lone one is a search word, not a question. */
const QUESTION_WORDS = /^(how|where|what|why|when|which|who|can|could|does|do|is|are|should|will|i want|i need)\b/;

/**
 * Whether the box holds a question rather than search words: the Ask row then comes first and Enter asks it. A
 * question mark does it, or a question word with a few more words after it.
 */
export function looksLikeQuestion(query: string): boolean {
  const text = normalize(query);
  if (text.endsWith("?")) return true;
  return QUESTION_WORDS.test(text) && text.split(" ").length >= 4;
}

/** The index as the Ask sends it: what the model reads to pick a setting. */
export function askEntries(entries: ReadonlyArray<SettingsIndexEntry>): SettingsAskEntry[] {
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    location: settingsLocation(entry),
    keywords: [...entry.keywords],
  }));
}

/** Where the highlight starts when results appear: on the Ask row for a question (or nothing found), else the best hit. */
export function initialActive(query: string, resultCount: number): number {
  return looksLikeQuestion(query) || resultCount === 0 ? 0 : 1;
}
