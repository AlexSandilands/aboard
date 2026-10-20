// Pure helpers for the command palette. Path handling adapted from T3 Code's
// client-runtime browse helpers (MIT) — see NOTICE.
import { parseImportSource, type FsBrowseResult, type TicketSystem } from "@repo/contracts";

// ── Item filtering ───────────────────────────────────────────────────────

export interface SearchableItem {
  readonly title: string;
  readonly searchTerms: ReadonlyArray<string>;
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Higher is better: exact title, title prefix, word prefix, then plain contains. */
function rankItem(item: SearchableItem, query: string): number {
  const title = normalizeSearchText(item.title);
  if (title === query) return 4;
  if (title.startsWith(query)) return 3;
  if (item.searchTerms.some((term) => normalizeSearchText(term) === query)) return 3;
  if (title.split(" ").some((word) => word.startsWith(query))) return 2;
  return 1;
}

/**
 * Keeps items whose title + search terms contain every query token, best matches first.
 * An empty query keeps everything in its original order.
 */
export function filterItems<T extends SearchableItem>(items: ReadonlyArray<T>, rawQuery: string): T[] {
  const query = normalizeSearchText(rawQuery);
  if (query.length === 0) return [...items];
  const tokens = query.split(" ");
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const haystack = normalizeSearchText([item.title, ...item.searchTerms].join(" "));
      return tokens.every((token) => haystack.includes(token));
    })
    .map((entry) => ({ ...entry, rank: rankItem(entry.item, query) }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((entry) => entry.item);
}

/** Search terms for a task row: `#12`, `12`, the title, its project and its labels. */
export function taskSearchTerms(
  task: { number: number; title: string; labels?: ReadonlyArray<string> },
  projectTitle: string | undefined,
): string[] {
  return [`#${task.number}`, String(task.number), task.title, projectTitle ?? "", ...(task.labels ?? [])];
}

// ── Path browsing ────────────────────────────────────────────────────────

/** Whether the typed text is a filesystem path the folder browser should list. */
export function isPathQuery(value: string): boolean {
  return value.startsWith("~") || value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:/.test(value);
}

/** At the palette root only an unambiguous path prefix starts browsing ("a:" could be a title). */
export function startsBrowseFromRoot(value: string): boolean {
  return /^(~[\\/]|[\\/]|[a-zA-Z]:[\\/])/.test(value);
}

function lastSeparatorIndex(value: string): number {
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

/** The separator a path already uses, so appended segments match the user's style. */
export function preferredSeparator(value: string): "/" | "\\" {
  const index = lastSeparatorIndex(value);
  if (index >= 0) return value[index] === "\\" ? "\\" : "/";
  return /^[a-zA-Z]:/.test(value) ? "\\" : "/";
}

export function hasTrailingSeparator(value: string): boolean {
  return /[\\/]$/.test(value);
}

export function withTrailingSeparator(value: string): string {
  return hasTrailingSeparator(value) ? value : `${value}${preferredSeparator(value)}`;
}

/**
 * Splits a typed path into the directory to list and the leaf segment that filters it.
 * `C:\Code\fo` → `{ directory: "C:\Code\", leaf: "fo" }`. A bare `~` or drive (`C:`) is
 * a directory with no leaf.
 */
export function splitBrowseQuery(value: string): { directory: string; leaf: string } {
  if (value === "~") return { directory: "~", leaf: "" };
  if (/^[a-zA-Z]:$/.test(value)) return { directory: `${value}\\`, leaf: "" };
  const index = lastSeparatorIndex(value);
  if (index < 0) return { directory: "", leaf: value };
  return { directory: value.slice(0, index + 1), leaf: value.slice(index + 1) };
}

/** Folders whose name starts with the leaf (case-insensitive); dot-folders only when the leaf starts with ".". */
export function filterBrowseEntries<T extends { name: string }>(entries: ReadonlyArray<T>, leaf: string): T[] {
  const lower = leaf.toLowerCase();
  const showHidden = leaf.startsWith(".");
  return entries.filter(
    (entry) => entry.name.toLowerCase().startsWith(lower) && (showHidden || !entry.name.startsWith(".")),
  );
}

/** The entry named exactly `leaf`, preferring a case-sensitive match. */
export function findExactEntry<T extends { name: string }>(entries: ReadonlyArray<T>, leaf: string): T | null {
  if (leaf.length === 0) return null;
  return (
    entries.find((entry) => entry.name === leaf) ??
    entries.find((entry) => entry.name.toLowerCase() === leaf.toLowerCase()) ??
    null
  );
}

/**
 * The query after choosing a folder: the folder appended in the user's separator style.
 * Drive roots from the Windows drive list (browsed as "/") replace the query outright.
 */
export function queryForEntry(query: string, entry: { name: string; fullPath: string }, listedPath: string): string {
  if (listedPath === "/" && /^[a-zA-Z]:[\\/]?$/.test(entry.fullPath)) return withTrailingSeparator(entry.fullPath);
  const directory = withTrailingSeparator(splitBrowseQuery(query).directory);
  return `${directory}${entry.name}${preferredSeparator(directory)}`;
}

/** The query for the ".." row: the listed folder's parent, with a trailing separator. */
export function queryForParent(parentPath: string): string {
  return withTrailingSeparator(parentPath);
}

/** Strips trailing separators, keeping roots like `/` and `C:\` intact. */
export function trimTrailingSeparators(path: string): string {
  if (/^[a-zA-Z]:[\\/]*$/.test(path)) return `${path.slice(0, 2)}\\`;
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.length === 0 ? path.slice(0, 1) : trimmed;
}

export type SubmitPathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Resolves the typed query to the absolute folder to add, using the listing of its
 * directory part. The server stores paths verbatim, so `~` must be resolved here.
 */
export function resolveSubmitPath(query: string, listing: FsBrowseResult | undefined): SubmitPathResult {
  const trimmed = query.trim();
  if (trimmed.length === 0 || !isPathQuery(trimmed)) return { ok: false, reason: "Type a folder path" };
  if (!listing) return { ok: false, reason: "Folder not found" };
  if (listing.path === "/" && listing.entries.some((entry) => /^[a-zA-Z]:/.test(entry.name))) {
    return { ok: false, reason: "Choose a drive" };
  }
  const { leaf } = splitBrowseQuery(trimmed);
  if (leaf.length === 0 || leaf === ".") return { ok: true, path: trimTrailingSeparators(listing.path) };
  const exact = findExactEntry(listing.entries, leaf);
  if (exact) return { ok: true, path: trimTrailingSeparators(exact.fullPath) };
  return { ok: false, reason: `No folder named "${leaf}"` };
}

/** The description to send on create: blank or whitespace-only means "not set". */
export function normalizeDescription(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** What pasting an issue into the title box does instead of creating a task with that title. */
export interface IssueImportRow {
  /** Sent as `sourceUrl`; the server fills in the title, description and labels. */
  sourceUrl: string;
  /** The row's title: "Import PROJ-123 from <System>". */
  title: string;
  description: string;
}

/**
 * Recognises a pasted ticket key or URL of a configured system, or a GitHub issue URL, in the title box. Only for tasks that land in Backlog:
 * a task that opens the plan editor is titled by the user.
 */
export function issueImportRow(
  query: string,
  flow: "backlog" | "planned" | "epic",
  ticketSystems: readonly TicketSystem[] = [],
): IssueImportRow | null {
  if (flow !== "backlog") return null;
  const source = parseImportSource(query, ticketSystems);
  if (!source) return null;
  return {
    sourceUrl: query.trim(),
    title: `Import ${source.placeholder} from ${
      source.kind === "ticket"
        ? (ticketSystems.find((s) => s.id === source.ref.system)?.name ?? source.ref.system)
        : "GitHub"
    }`,
    description: "Fills in the title, description and labels from the issue in the background",
  };
}
