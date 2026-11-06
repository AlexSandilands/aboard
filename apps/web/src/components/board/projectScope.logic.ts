import { parseProjectScope } from "@repo/contracts";
import type { BoardSearch } from "~/router";

/**
 * The `?project=` to put on the board when the app starts on it, from the scope remembered last time; undefined to
 * leave the URL as it is. Only a bare board gets it: an explicit `?project=` (a bookmark, a shared link, a saved
 * view) wins, and the in-progress filter looks across every project, so a scope would end it.
 */
export function restoredProjectScope(
  pathname: string,
  search: Pick<BoardSearch, "project" | "inprogress">,
  remembered: ReadonlyArray<string>,
): string | undefined {
  if (pathname !== "/" || search.project || search.inprogress) return undefined;
  // Written as the URL would be, so the same scope always makes the same URL.
  return parseProjectScope(remembered.join(",")).join(",") || undefined;
}
