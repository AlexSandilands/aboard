// The project picker of the settings pages: "Settings for [All projects ▾]" at the top of the Projects page, kept in the
// URL as `?project=` (after T3 Code's settings scope, MIT, see NOTICE), and the same picker inside a section that lists
// one project's things (Autopilot's variables and recurring tasks).
import type { SettingsGroupId } from "./settingsNav.logic";

/** The pages that show the scope sentence: only Projects, which holds what a project sets for itself. */
export const SCOPED_GROUPS: ReadonlySet<SettingsGroupId> = new Set(["project"]);

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

/** The project settings a project can set over the board's, as the Projects page's overrides list them. */
export type ProjectOverrideField = "planSkill" | "reviewSkill" | "reviewModel";

/** The live projects that set their own value for a field, in sidebar order: a board row's "Overridden in N projects". */
export function overridingProjects<
  P extends { id: string; position: string; archivedAt?: string | null } & Partial<
    Record<ProjectOverrideField, unknown>
  >,
>(projects: ReadonlyArray<P> | undefined, field: ProjectOverrideField): P[] {
  return scopeProjects(projects).filter((p) => p[field] != null);
}
