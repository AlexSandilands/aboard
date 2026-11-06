import { parseProjectScope } from "@repo/contracts";
import type { BoardSearch } from "~/router";

type ScopeSearch = Pick<BoardSearch, "project" | "inprogress">;

/**
 * The `?project=` to put on the board when the app starts on it, from the scope remembered last time; undefined to
 * leave the URL as it is. Only a bare board gets it: an explicit `?project=` (a bookmark, a shared link, a saved
 * view) wins, and the in-progress filter looks across every project, so a scope would end it.
 */
export function restoredProjectScope(
  pathname: string,
  search: ScopeSearch,
  remembered: ReadonlyArray<string>,
): string | undefined {
  if (pathname !== "/" || search.project || search.inprogress) return undefined;
  // Written as the URL would be, so the same scope always makes the same URL.
  return parseProjectScope(remembered.join(",")).join(",") || undefined;
}

/**
 * The scope to remember for the board the URL shows, or null to leave what is remembered alone. The URL is the only
 * input, so every way of changing the scope (the project menu, the palette, a saved view, Back) is remembered, and
 * All projects forgets it. Other pages and the in-progress filter, which suspends the scope, change nothing.
 * `order` is the board's project ids once loaded: ids of projects that are gone are dropped then.
 */
export function scopeToRemember(pathname: string, search: ScopeSearch, order?: ReadonlyArray<string>): string[] | null {
  if (pathname !== "/" || search.inprogress) return null;
  return parseProjectScope(search.project, order);
}
