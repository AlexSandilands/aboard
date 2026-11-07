import { z } from "zod";
import { AutopilotMode, AutopilotScopeKind } from "./autopilot.ts";

// "Where it runs": one automation's switches at every scope, read as one sentence and edited as Everywhere / Only in…
// / exceptions. It is only a presentation of the same `autopilot_settings` rows that `resolveAutopilot` reads: the
// board's mode, each project's and each epic's. Nothing here stores anything new (docs/features/autopilot.md).

/** One stored switch: an automation's mode at one scope. Only rows that aren't Inherit exist, so only those are listed. */
export const AutopilotModeRow = z.object({
  scopeKind: AutopilotScopeKind,
  /** Null for the board. */
  scopeId: z.string().nullable(),
  automation: z.string(),
  mode: AutopilotMode,
});
export type AutopilotModeRow = z.infer<typeof AutopilotModeRow>;

export interface WhereProject {
  id: string;
  title: string;
  /** The project's own mode for the automation (inherit when it has no row). */
  mode: AutopilotMode;
}

export interface WhereEpic {
  id: string;
  number: number;
  projectId: string;
  /** The epic's own mode for the automation. */
  mode: AutopilotMode;
}

/** An automation's modes at the scopes the board has: everything `describeWhere` and the edits below read. */
export interface WhereInput {
  board: AutopilotMode;
  projects: ReadonlyArray<WhereProject>;
  epics: ReadonlyArray<WhereEpic>;
}

/** Everywhere: the board is on. Only: the board is off and some projects are on. Nowhere: neither. */
export type WhereReach = "everywhere" | "only" | "nowhere";

/** A project or epic whose own setting differs from what the scope above gives it. */
export interface WhereException {
  scope: "project" | "epic";
  id: string;
  /** The project's title, or "epic #5". */
  label: string;
  /** What it is set to; the opposite of what it would follow. */
  mode: "on" | "off";
}

export interface WhereDescription {
  reach: WhereReach;
  /** Whether it runs anywhere at all. */
  on: boolean;
  /** Under `only`, the projects that are on, in the order given. Empty otherwise. */
  projects: string[];
  /** Everywhere: projects switched off. Always: epics that differ from their project. In the order given. */
  exceptions: WhereException[];
  /** "On everywhere except payments-api; epic #5 Off". */
  sentence: string;
}

/** The modes of one automation, from every stored row. Scopes with no row are Inherit. */
export function whereInput(
  rows: ReadonlyArray<AutopilotModeRow>,
  automation: string,
  projects: ReadonlyArray<{ id: string; title: string }>,
  epics: ReadonlyArray<{ id: string; number: number; projectId: string }>,
): WhereInput {
  const modeAt = (kind: AutopilotScopeKind, id: string | null): AutopilotMode =>
    rows.find((r) => r.automation === automation && r.scopeKind === kind && r.scopeId === id)?.mode ?? "inherit";
  return {
    board: modeAt("board", null),
    projects: projects.map((p) => ({ ...p, mode: modeAt("project", p.id) })),
    epics: epics.map((e) => ({ ...e, mode: modeAt("epic", e.id) })),
  };
}

/** Whether a project is on before any epic of it is looked at. The board's Inherit is off. */
export function projectIsOn(board: AutopilotMode, project: Pick<WhereProject, "mode">): boolean {
  return board === "on" ? project.mode !== "off" : project.mode === "on";
}

const epicLabel = (epic: Pick<WhereEpic, "number">): string => `epic #${epic.number}`;

/** "a", "a, b", "a, b, c" or "a, b, c and 2 more", so a long list can't swallow the sentence. */
function nameList(names: ReadonlyArray<string>): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** The epics whose own setting makes them differ from their project, as exceptions. */
function epicExceptions(input: WhereInput): WhereException[] {
  const out: WhereException[] = [];
  for (const epic of input.epics) {
    if (epic.mode === "inherit") continue;
    const project = input.projects.find((p) => p.id === epic.projectId);
    if (!project) continue;
    // An epic set the same as its project changes nothing, so it isn't an exception.
    if ((epic.mode === "on") === projectIsOn(input.board, project)) continue;
    out.push({ scope: "epic", id: epic.id, label: epicLabel(epic), mode: epic.mode });
  }
  return out;
}

/** The effective state as a reach, the exceptions and one sentence. */
export function describeWhere(input: WhereInput): WhereDescription {
  const epics = epicExceptions(input);
  const epicPart =
    epics.length > 0 ? `; ${epics.map((e) => `${e.label} ${e.mode === "on" ? "On" : "Off"}`).join(", ")}` : "";
  if (input.board === "on") {
    const off = input.projects.filter((p) => p.mode === "off");
    const exceptions: WhereException[] = [
      ...off.map((p): WhereException => ({ scope: "project", id: p.id, label: p.title, mode: "off" })),
      ...epics,
    ];
    const except = off.length > 0 ? ` except ${nameList(off.map((p) => p.title))}` : "";
    return { reach: "everywhere", on: true, projects: [], exceptions, sentence: `On everywhere${except}${epicPart}` };
  }
  const on = input.projects.filter((p) => p.mode === "on");
  if (on.length > 0) {
    return {
      reach: "only",
      on: true,
      projects: on.map((p) => p.id),
      exceptions: epics,
      sentence: `On only in ${nameList(on.map((p) => p.title))}${epicPart}`,
    };
  }
  return {
    reach: "nowhere",
    // An epic switched on in a project that is off still runs there.
    on: epics.some((e) => e.mode === "on"),
    projects: [],
    exceptions: epics,
    sentence: `Off everywhere${epicPart}`,
  };
}

// ── Edits ────────────────────────────────────────────────────────────────

export type WhereTarget =
  | { kind: "board" }
  | { kind: "project"; id: string }
  | { kind: "epic"; id: string; projectId: string };

/** One mode to save at one scope. Inherit with no config removes the row (the server's rule). */
export interface WhereWrite {
  target: WhereTarget;
  mode: AutopilotMode;
}

/**
 * The mode a scope needs to end up `on` or off, given whether the scope above it is on. When the scope above already
 * gives that, the scope follows it (Inherit) and holds no row of its own: that is how a toggle stays free of
 * redundant overrides.
 */
export function modeToBe(parentOn: boolean, on: boolean): AutopilotMode {
  if (parentOn === on) return "inherit";
  return on ? "on" : "off";
}

const writeIf = (writes: WhereWrite[], target: WhereTarget, current: AutopilotMode, next: AutopilotMode): void => {
  if (current !== next) writes.push({ target, mode: next });
};

/** The board on. Project and epic rows are left as they are: those set Off become the exceptions. */
export function whereEverywhere(input: WhereInput): WhereWrite[] {
  return input.board === "on" ? [] : [{ target: { kind: "board" }, mode: "on" }];
}

/**
 * Only in these projects: the board off (Inherit, which is Off), those projects On, and any other project that was On
 * back to Inherit. A project already Off stays so; it is just redundant while the board is off.
 */
export function whereOnlyIn(input: WhereInput, projectIds: ReadonlyArray<string>): WhereWrite[] {
  const writes: WhereWrite[] = [];
  // The board is saved as Inherit rather than Off, as its own switch does: both resolve to Off.
  if (input.board !== "inherit" && input.board !== "off") writes.push({ target: { kind: "board" }, mode: "inherit" });
  for (const project of input.projects) {
    const target: WhereTarget = { kind: "project", id: project.id };
    if (projectIds.includes(project.id)) writeIf(writes, target, project.mode, "on");
    else if (project.mode === "on") writes.push({ target, mode: "inherit" });
  }
  return writes;
}

/** The projects that are on now, for "Only in…" to start from when it is picked over Everywhere. */
export function currentOnProjects(input: WhereInput): string[] {
  return input.projects.filter((p) => projectIsOn(input.board, p)).map((p) => p.id);
}

/** Switches one project on or off, as itself and not as an override when the board already gives that. */
export function whereProject(input: WhereInput, projectId: string, on: boolean): WhereWrite[] {
  const project = input.projects.find((p) => p.id === projectId);
  if (!project) return [];
  const writes: WhereWrite[] = [];
  writeIf(writes, { kind: "project", id: projectId }, project.mode, modeToBe(input.board === "on", on));
  return writes;
}

/** Switches one epic on or off, as itself and not as an override when its project already gives that. */
export function whereEpic(input: WhereInput, epicId: string, on: boolean): WhereWrite[] {
  const epic = input.epics.find((e) => e.id === epicId);
  const project = epic && input.projects.find((p) => p.id === epic.projectId);
  if (!epic || !project) return [];
  const writes: WhereWrite[] = [];
  writeIf(
    writes,
    { kind: "epic", id: epic.id, projectId: epic.projectId },
    epic.mode,
    modeToBe(projectIsOn(input.board, project), on),
  );
  return writes;
}

/** A project or epic that + Exception can offer, with the mode it would be given. */
export interface WhereCandidate extends WhereException {
  /** Set for an epic, which is saved through its project. */
  projectId?: string;
}

/**
 * What + Exception offers: while it runs everywhere, each project not yet Off (to switch off); always, each epic
 * not yet an exception, to the opposite of its project. Under Only in… a project is picked with its chip instead.
 */
export function whereCandidates(input: WhereInput): WhereCandidate[] {
  const out: WhereCandidate[] = [];
  if (input.board === "on") {
    for (const p of input.projects) {
      if (p.mode !== "off") out.push({ scope: "project", id: p.id, label: p.title, mode: "off" });
    }
  }
  const taken = new Set(epicExceptions(input).map((e) => e.id));
  for (const epic of input.epics) {
    const project = input.projects.find((p) => p.id === epic.projectId);
    if (!project || taken.has(epic.id)) continue;
    out.push({
      scope: "epic",
      id: epic.id,
      label: epicLabel(epic),
      mode: projectIsOn(input.board, project) ? "off" : "on",
      projectId: epic.projectId,
    });
  }
  return out;
}

/** Adds an exception: the row's own mode, explicit. */
export function whereAddException(
  candidate: Pick<WhereCandidate, "scope" | "id" | "mode" | "projectId">,
): WhereWrite[] {
  if (candidate.scope === "project") return [{ target: { kind: "project", id: candidate.id }, mode: candidate.mode }];
  if (!candidate.projectId) return [];
  return [{ target: { kind: "epic", id: candidate.id, projectId: candidate.projectId }, mode: candidate.mode }];
}

/** Removes an exception: the row follows the scope above again. */
export function whereRemoveException(input: WhereInput, exception: Pick<WhereException, "scope" | "id">): WhereWrite[] {
  if (exception.scope === "project") return [{ target: { kind: "project", id: exception.id }, mode: "inherit" }];
  const epic = input.epics.find((e) => e.id === exception.id);
  return epic ? [{ target: { kind: "epic", id: epic.id, projectId: epic.projectId }, mode: "inherit" }] : [];
}

/**
 * The stored switches after the writes, for a UI to show an edit before the server has answered. Inherit takes the row
 * away, as the list only holds switches that are set.
 */
export function applyWhereWrites(
  rows: ReadonlyArray<AutopilotModeRow>,
  automation: string,
  writes: ReadonlyArray<WhereWrite>,
): AutopilotModeRow[] {
  let next = [...rows];
  for (const { target, mode } of writes) {
    const scopeKind = target.kind;
    const scopeId = target.kind === "board" ? null : target.id;
    next = next.filter((r) => !(r.automation === automation && r.scopeKind === scopeKind && r.scopeId === scopeId));
    if (mode !== "inherit") next.push({ scopeKind, scopeId, automation, mode });
  }
  return next;
}
