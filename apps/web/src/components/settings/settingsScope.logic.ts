// The project scope of the settings pages: "Applying settings for [All projects ▾]" at the top of the pages that have
// something per project, kept in the URL as `?project=` (after T3 Code's settings scope, MIT, see NOTICE).
import type { SettingsGroupId } from "./settingsNav.logic";

/** The pages that show the scope sentence: the ones with settings a project can set for itself. */
export const SCOPED_GROUPS: ReadonlySet<SettingsGroupId> = new Set(["tasks", "agents", "autopilot", "project"]);

export const isScopedGroup = (group: SettingsGroupId | null | undefined): boolean =>
  group != null && SCOPED_GROUPS.has(group);

/** Up to this many projects the scope is a menu; past it, a combobox with a search box. */
export const SCOPE_MENU_MAX = 6;

export const usesScopeSearch = (projectCount: number): boolean => projectCount > SCOPE_MENU_MAX;

/**
 * The project a scope names, or null for All projects. An id that is gone (deleted, or archived) reads as All
 * projects rather than a dead end.
 */
export function scopeProject<P extends { id: string; archivedAt?: string | null }>(
  projects: ReadonlyArray<P> | undefined,
  requested: string | null | undefined,
): P | null {
  if (!requested || !projects) return null;
  return projects.find((p) => p.id === requested && !p.archivedAt) ?? null;
}

/** The projects the menu lists: live ones, in sidebar order. */
export function scopeProjects<P extends { id: string; position: string; archivedAt?: string | null }>(
  projects: ReadonlyArray<P> | undefined,
): P[] {
  return (projects ?? [])
    .filter((p) => !p.archivedAt)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

/** The combobox's matches: titles holding the query, ignoring case and surrounding spaces. */
export function filterScopeOptions<O extends { label: string }>(options: ReadonlyArray<O>, query: string): O[] {
  const needle = query.trim().toLowerCase();
  return needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : [...options];
}

/** The search to keep on a settings navigation so the scope survives it (T3's `retainSettingsScope`). */
export const scopeSearch = (project: string | null | undefined): { project?: string } => (project ? { project } : {});

/**
 * How a settings row behaves in the scope it is shown in. A row is `board` (one value for every project), `project`
 * (a project can set its own) or `any` (not a setting: a list, an action). In project scope a board row is dimmed and
 * inert, so the page doesn't jump when the scope changes; in All projects scope every row is live.
 */
export type RowScope = "board" | "project" | "any";

export function rowIsInert(row: RowScope, projectScope: boolean): boolean {
  return projectScope && row === "board";
}

/** The tooltip on a dimmed board-wide row. */
export const BOARD_WIDE_HINT = "Applies to every project. Choose All projects above to change it.";
