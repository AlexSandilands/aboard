import {
  projectIsOn,
  whereEpic,
  whereProject,
  type BoardSnapshot,
  type WhereInput,
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
export const turnsOn = (writes: ReadonlyArray<WhereWrite>): boolean => writes.some((w) => w.mode === "on");

/** The scope a popover is for: one project, or one epic. */
export type PopoverScope = { kind: "project"; id: string } | { kind: "epic"; id: string };

/** Whether the automation is on at this scope, as the engine resolves it; null when the scope isn't in `input`. */
export function scopeIsOn(input: WhereInput, scope: PopoverScope): boolean | null {
  if (scope.kind === "project") {
    const project = input.projects.find((p) => p.id === scope.id);
    return project ? projectIsOn(input.board, project) : null;
  }
  const epic = input.epics.find((e) => e.id === scope.id);
  const project = epic && input.projects.find((p) => p.id === epic.projectId);
  if (!epic || !project) return null;
  return epic.mode === "inherit" ? projectIsOn(input.board, project) : epic.mode === "on";
}

/** The writes for switching the automation on or off at this scope: an override only where the scope above differs. */
export const scopeToggle = (input: WhereInput, scope: PopoverScope, on: boolean): WhereWrite[] =>
  scope.kind === "project" ? whereProject(input, scope.id, on) : whereEpic(input, scope.id, on);
