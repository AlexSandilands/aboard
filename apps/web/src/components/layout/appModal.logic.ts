/**
 * Whether a path renders in a floating window over the board (Settings and Stats), not as a page of its own.
 * The board stays mounted behind such a path and reads its search from where it was left, not from the URL.
 */
export function isAppModalPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/stats";
}

/** Whether the board is rendered for a path: on the board itself, and behind a window. */
export function showsBoard(pathname: string): boolean {
  return pathname === "/" || isAppModalPath(pathname);
}

/**
 * The board's search for a path: the URL's on the board, and anywhere else the board as it was left (`kept`). A
 * window's own search must not reach the board behind it: Settings and Stats use `?project=` for something else.
 */
export function boardSearchAt<T>(pathname: string, url: T, kept: T): T {
  return pathname === "/" ? url : kept;
}
