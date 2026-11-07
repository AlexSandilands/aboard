import {
  projectState,
  stateOf,
  whereEpic,
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
  return { projects, epics };
}

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
