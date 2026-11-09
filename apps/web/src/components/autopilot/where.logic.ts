import {
  boardState,
  projectState,
  stateOf,
  whereEpic,
  whereOwnOn,
  whereProject,
  type AutopilotAutomation,
  type BoardSnapshot,
  type WhereInput,
  type WhereState,
  type WhereWrite,
} from "@repo/contracts";

/** The projects and epics the Where it runs widget knows about, from the board: the ones still in use. */
export interface WhereScopes {
  /** In lane order. */
  projects: Array<{ id: string; title: string }>;
  /** The General project, or null when there is none: an automation that needs a repository leaves it out. */
  generalId: string | null;
  /** Epics not archived, by number; an archived epic no longer counts as a scope. Empty when the automation has no epic scope. */
  epics: Array<{ id: string; number: number; projectId: string; title: string }>;
}

export function whereScopes(board: BoardSnapshot | undefined, epicScope: boolean): WhereScopes | null {
  if (!board) return null;
  const projects = board.projects
    .filter((p) => p.archivedAt === null)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map((p) => ({ id: p.id, title: p.title }));
  const live = new Set(projects.map((p) => p.id));
  const epics = epicScope
    ? board.tasks
        .filter((t) => t.kind === "epic" && t.archivedAt === null && live.has(t.projectId))
        .sort((a, b) => a.number - b.number)
        .map((t) => ({ id: t.id, number: t.number, projectId: t.projectId, title: t.title }))
    : [];
  return { projects, epics, generalId: board.generalProjectId };
}

/** The table's rows: an automation that needs a repository leaves out General, which has none. */
export const tableProjects = (scopes: WhereScopes, needsRepo: boolean): WhereScopes["projects"] =>
  needsRepo ? scopes.projects.filter((p) => p.id !== scopes.generalId) : scopes.projects;

/** Whether any of the writes turns something on: refused by the server for an automation that is blocked. */
export const turnsOn = (writes: ReadonlyArray<WhereWrite>): boolean =>
  writes.some((w) => w.mode === "on" || w.mode === "preview");

/** The scope a popover is for: one project, or one epic. */
export type PopoverScope = { kind: "project"; id: string } | { kind: "epic"; id: string };

/** What the automation does at this scope, as the engine resolves it; null when the scope isn't in `input`. */
export function scopeState(input: WhereInput, scope: PopoverScope): WhereState | null {
  if (scope.kind === "project") {
    const project = input.projects.find((p) => p.id === scope.id);
    return project ? projectState(input.board, project) : null;
  }
  const epic = input.epics.find((e) => e.id === scope.id);
  const project = epic && input.projects.find((p) => p.id === epic.projectId);
  if (!epic || !project) return null;
  return stateOf(epic.mode, projectState(input.board, project));
}

/** Whether the automation runs at this scope (in Preview too); null when the scope isn't in `input`. */
export function scopeIsOn(input: WhereInput, scope: PopoverScope): boolean | null {
  const state = scopeState(input, scope);
  return state === null ? null : state !== "off";
}

/** The writes for switching the automation on or off at this scope: an override only where the scope above differs. */
export const scopeToggle = (input: WhereInput, scope: PopoverScope, on: boolean): WhereWrite[] =>
  scope.kind === "project" ? whereProject(input, scope.id, on) : whereEpic(input, scope.id, on);

/**
 * The settings a project sets for itself on an automation ("Budget, Skill"), or null when it sets none. They apply
 * over the board's, and the project page is where they show and are cleared. A key the automation no longer has is
 * listed by its name.
 */
export function ownSettingsLabel(
  automation: Pick<AutopilotAutomation, "fields">,
  config: Readonly<Record<string, unknown>>,
): string | null {
  const keys = Object.keys(config);
  if (keys.length === 0) return null;
  return keys.map((key) => automation.fields.find((f) => f.key === key)?.label ?? key).join(", ");
}

/** What a table header switch shows for its column: the rows' states, not the stored board value. */
export type ColumnState = "on" | "off" | "mixed";

/** Whether the column is on in every row, in none or in some. */
export function columnState(rows: readonly boolean[]): ColumnState {
  const on = rows.filter(Boolean).length;
  if (on === 0) return "off";
  return on === rows.length ? "on" : "mixed";
}

/** What a click on the header does: mixed counts as on somewhere, so only a column that is all off turns on. */
export const headerTurnsOn = (state: ColumnState): boolean => state === "off";

/** The per-project switches a header click would drop, for asking first. */
export interface HeaderLoss {
  /** Titles of the projects listed in the table. */
  projects: string[];
  epics: number;
}

/**
 * What a header click takes away, or null when it takes nothing a person set. Switching off drops every own On or
 * Preview (`whereOwnOn`); turning on drops the projects set Off, but only under a board that is on: under one that is
 * off those rows change nothing. Projects missing from `shown` (General, where it is left out) go unmentioned, since
 * nobody can see them to miss them.
 */
export function headerLoss(input: WhereInput, shown: readonly string[], turnOn: boolean): HeaderLoss | null {
  const titles = (projects: ReadonlyArray<{ id: string; title: string }>) =>
    projects.filter((p) => shown.includes(p.id)).map((p) => p.title);
  if (turnOn) {
    if (boardState(input.board) === "off") return null;
    const projects = titles(input.projects.filter((p) => p.mode === "off"));
    return projects.length > 0 ? { projects, epics: 0 } : null;
  }
  const own = whereOwnOn(input);
  const projects = titles(own.projects);
  return projects.length + own.epics.length > 0 ? { projects, epics: own.epics.length } : null;
}

/** The builder's and import's choice, kept in the form until saved. */
export interface DraftWhere {
  everywhere: boolean;
  projectIds: string[];
}

export const draftRowOn = (draft: DraftWhere, id: string): boolean => draft.everywhere || draft.projectIds.includes(id);

/** One row's switch. Under Everywhere that means picking all the others, so nothing else changes. */
export function draftRowToggle(draft: DraftWhere, allIds: readonly string[], id: string, on: boolean): DraftWhere {
  const picked = draft.everywhere ? [...allIds] : draft.projectIds.filter((other) => allIds.includes(other));
  return {
    everywhere: false,
    projectIds: on ? [...picked.filter((other) => other !== id), id] : picked.filter((other) => other !== id),
  };
}

/** The header's click: every project, new ones too, or none. Either way no project is picked on its own any more. */
export const draftHeader = (turnOn: boolean): DraftWhere => ({ everywhere: turnOn, projectIds: [] });

/** Up to this many projects, the table shows them all; past it, a search box above the rows. */
export const PROJECT_CHIPS_MAX = 8;

export const usesProjectSearch = (projectCount: number): boolean => projectCount > PROJECT_CHIPS_MAX;

/** The projects whose title holds the search, ignoring case and surrounding spaces; all of them for an empty one. */
export function filterProjects<P extends { title: string }>(projects: readonly P[], query: string): P[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter((p) => p.title.toLowerCase().includes(q)) : [...projects];
}
