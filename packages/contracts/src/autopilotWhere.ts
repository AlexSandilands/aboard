import { z } from "zod";
import { AutopilotMode, AutopilotScopeKind } from "./autopilot.ts";

// "Where it runs": one automation's switches at every scope, read as one sentence and edited as the project table.
// It is only a presentation of the same `autopilot_settings` rows that `resolveAutopilot` reads: the
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

/** What an automation does somewhere: nothing, only record what it would do (Preview), or run. */
export type WhereState = "off" | "preview" | "on";

/** A scope's state: its own mode, or the scope above's while it is Inherit. */
export function stateOf(mode: AutopilotMode, parent: WhereState): WhereState {
  return mode === "inherit" ? parent : mode;
}

/** The board's state; Inherit there is Off. */
export const boardState = (board: AutopilotMode): WhereState => stateOf(board, "off");

/** A project's state before any epic of it is looked at. */
export const projectState = (board: AutopilotMode, project: Pick<WhereProject, "mode">): WhereState =>
  stateOf(project.mode, boardState(board));

/** Everywhere: the board is on or in Preview. Only: the board is off and some projects are on. Nowhere: neither. */
export type WhereReach = "everywhere" | "only" | "nowhere";

/** A project or epic whose own setting differs from what the scope above gives it. */
export interface WhereException {
  scope: "project" | "epic";
  id: string;
  /** The project's title, or "epic #5". */
  label: string;
  /** What it ends up as, different from what it would follow. */
  mode: WhereState;
}

export interface WhereDescription {
  reach: WhereReach;
  /** Whether it runs anywhere at all (in Preview too). */
  on: boolean;
  /** What the board itself does: Everywhere is On or Preview. */
  state: WhereState;
  /** Under `only`, the projects that are on or in Preview, in the order given. Empty otherwise. */
  projects: string[];
  /** Of those, the ones that are only in Preview. */
  previewProjects: string[];
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

const isOn = (state: WhereState): boolean => state !== "off";
const stateLabel = (state: WhereState): string => (state === "on" ? "On" : state === "preview" ? "Preview" : "Off");

/** Whether a project is on (in Preview too) before any epic of it is looked at. The board's Inherit is off. */
export function projectIsOn(board: AutopilotMode, project: Pick<WhereProject, "mode">): boolean {
  return isOn(projectState(board, project));
}

const epicLabel = (epic: Pick<WhereEpic, "number">): string => `epic #${epic.number}`;

/** "a", "a, b", "a, b, c" or "a, b, c and 2 more", so a long list can't swallow the sentence. */
function nameList(names: ReadonlyArray<string>): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** An epic's state, through its project and the board. Null when its project isn't in the input. */
function epicStateOf(input: WhereInput, epic: WhereEpic): WhereState | null {
  const project = input.projects.find((p) => p.id === epic.projectId);
  return project ? stateOf(epic.mode, projectState(input.board, project)) : null;
}

/** The epics whose own setting makes them differ from their project, as exceptions. */
function epicExceptions(input: WhereInput): WhereException[] {
  const out: WhereException[] = [];
  for (const epic of input.epics) {
    if (epic.mode === "inherit") continue;
    const project = input.projects.find((p) => p.id === epic.projectId);
    if (!project) continue;
    // An epic set the same as its project changes nothing, so it isn't an exception.
    if (epic.mode === projectState(input.board, project)) continue;
    out.push({ scope: "epic", id: epic.id, label: epicLabel(epic), mode: epic.mode });
  }
  return out;
}

/** The effective state as a reach, the exceptions and one sentence. */
export function describeWhere(input: WhereInput): WhereDescription {
  const epics = epicExceptions(input);
  const epicParts = epics.map((e) => `${e.label} ${stateLabel(e.mode)}`);
  const board = boardState(input.board);
  if (isOn(board)) {
    const differing = input.projects
      .map((p) => ({ p, state: projectState(input.board, p) }))
      .filter(({ state }) => state !== board);
    const exceptions: WhereException[] = [
      ...differing.map(({ p, state }): WhereException => ({ scope: "project", id: p.id, label: p.title, mode: state })),
      ...epics,
    ];
    const off = differing.filter(({ state }) => state === "off").map(({ p }) => p.title);
    const others = differing
      .filter(({ state }) => state !== "off")
      .map(({ p, state }) => `${p.title} ${stateLabel(state)}`);
    const tail = [...others, ...epicParts];
    return {
      reach: "everywhere",
      on: true,
      state: board,
      projects: [],
      previewProjects: [],
      exceptions,
      sentence: `${stateLabel(board)} everywhere${off.length > 0 ? ` except ${nameList(off)}` : ""}${tail.length > 0 ? `; ${tail.join(", ")}` : ""}`,
    };
  }
  const onProjects = input.projects.filter((p) => isOn(projectState(input.board, p)));
  if (onProjects.length > 0) {
    const live = onProjects.filter((p) => projectState(input.board, p) === "on").map((p) => p.title);
    const preview = onProjects.filter((p) => projectState(input.board, p) === "preview");
    const head =
      live.length > 0 ? `On only in ${nameList(live)}` : `Preview only in ${nameList(preview.map((p) => p.title))}`;
    const tail = [
      ...(live.length > 0 && preview.length > 0 ? [`Preview in ${nameList(preview.map((p) => p.title))}`] : []),
      ...epicParts,
    ];
    return {
      reach: "only",
      on: true,
      state: "off",
      projects: onProjects.map((p) => p.id),
      previewProjects: preview.map((p) => p.id),
      exceptions: epics,
      sentence: `${head}${tail.length > 0 ? `; ${tail.join(", ")}` : ""}`,
    };
  }
  return {
    reach: "nowhere",
    // An epic switched on (or into Preview) in a project that is off still runs there.
    on: epics.some((e) => e.mode !== "off"),
    state: "off",
    projects: [],
    previewProjects: [],
    exceptions: epics,
    sentence: `Off everywhere${epicParts.length > 0 ? `; ${epicParts.join(", ")}` : ""}`,
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
 * The mode a scope needs to end up on or off, given whether the scope above it is on. When the scope above already
 * gives that, the scope follows it (Inherit) and holds no row of its own: that is how a toggle stays free of
 * redundant overrides. Turned on under a scope that is off it is On, not Preview.
 */
export function modeToBe(parentOn: boolean, on: boolean): AutopilotMode {
  if (parentOn === on) return "inherit";
  return on ? "on" : "off";
}

/**
 * The board on (or in Preview, as `mode` says; a board that is already on or in Preview keeps its mode), and the rows
 * that only made sense under Only in… dropped: a project set On or to Preview (redundant now, and it would keep the
 * automation running there after the board is switched off) and an epic set the same as its project. Projects set Off
 * stay, as the exceptions. The board goes first, so nothing is off on the way.
 */
export function whereEverywhere(input: WhereInput, mode: "on" | "preview" = "on"): WhereWrite[] {
  return everywhereWrites(input, mode, false);
}

/**
 * Every project on: `whereEverywhere`, but a project set Off is cleared too, so it follows the board. The project
 * table's header needs this because it shows the rows, and a row left Off would keep the column from turning on. The
 * board still goes first, so nothing is off on the way. An epic's own setting is left alone unless it now only
 * repeats its project, as under Everywhere.
 */
export function whereOnEverywhere(input: WhereInput, mode: "on" | "preview" = "on"): WhereWrite[] {
  return everywhereWrites(input, mode, true);
}

function everywhereWrites(input: WhereInput, mode: "on" | "preview", clearOff: boolean): WhereWrite[] {
  const writes: WhereWrite[] = [];
  const current = boardState(input.board);
  const next: WhereState = current !== "off" ? current : mode;
  if (current === "off") writes.push({ target: { kind: "board" }, mode });
  for (const project of input.projects) {
    if (project.mode === "on" || project.mode === "preview" || (clearOff && project.mode === "off")) {
      writes.push({ target: { kind: "project", id: project.id }, mode: "inherit" });
    }
  }
  for (const epic of input.epics) {
    const project = input.projects.find((p) => p.id === epic.projectId);
    if (!project || epic.mode === "inherit") continue;
    // What its project ends up as: Off if it stays set Off, else the board's state (its own row was just dropped).
    const projectEnds: WhereState = project.mode === "off" && !clearOff ? "off" : next;
    if (epic.mode === projectEnds) {
      writes.push({ target: { kind: "epic", id: epic.id, projectId: epic.projectId }, mode: "inherit" });
    }
  }
  return writes;
}

/** The projects and epics that set their own On or Preview: they keep running when only the board is switched off. */
export function whereOwnOn(input: WhereInput): { projects: WhereProject[]; epics: WhereEpic[] } {
  const ownOn = (mode: AutopilotMode) => mode === "on" || mode === "preview";
  return { projects: input.projects.filter((p) => ownOn(p.mode)), epics: input.epics.filter((e) => ownOn(e.mode)) };
}

/**
 * Off everywhere: the board off (Inherit, as its own switch saves it) and every project or epic that sets its own On
 * or Preview back to Inherit, so nothing is left running. Projects and epics set Off keep their row; it is redundant
 * while everything is off and comes back as an exception when the board is switched on again.
 */
export function whereOffEverywhere(input: WhereInput): WhereWrite[] {
  const writes: WhereWrite[] = [];
  const own = whereOwnOn(input);
  for (const epic of own.epics) {
    writes.push({ target: { kind: "epic", id: epic.id, projectId: epic.projectId }, mode: "inherit" });
  }
  for (const project of own.projects) writes.push({ target: { kind: "project", id: project.id }, mode: "inherit" });
  if (input.board !== "inherit" && input.board !== "off") writes.push({ target: { kind: "board" }, mode: "inherit" });
  return writes;
}

/** Switches one project on or off, as itself and not as an override when the board already gives that. */
export function whereProject(input: WhereInput, projectId: string, on: boolean): WhereWrite[] {
  const project = input.projects.find((p) => p.id === projectId);
  if (!project || projectIsOn(input.board, project) === on) return [];
  return [{ target: { kind: "project", id: projectId }, mode: modeToBe(isOn(boardState(input.board)), on) }];
}

/**
 * Puts a running project into Preview or back to acting for real, storing nothing when that is what the board gives.
 * A project that is off has nothing to preview, so it gets no write.
 */
export function whereProjectPreview(input: WhereInput, projectId: string, preview: boolean): WhereWrite[] {
  const project = input.projects.find((p) => p.id === projectId);
  if (!project) return [];
  const state = projectState(input.board, project);
  const next: WhereState = preview ? "preview" : "on";
  if (state === "off" || state === next) return [];
  return [{ target: { kind: "project", id: projectId }, mode: boardState(input.board) === next ? "inherit" : next }];
}

/** Switches one epic on or off, as itself and not as an override when its project already gives that. */
export function whereEpic(input: WhereInput, epicId: string, on: boolean): WhereWrite[] {
  const epic = input.epics.find((e) => e.id === epicId);
  const project = epic && input.projects.find((p) => p.id === epic.projectId);
  const state = epic ? epicStateOf(input, epic) : null;
  if (!epic || !project || state === null || isOn(state) === on) return [];
  return [
    {
      target: { kind: "epic", id: epic.id, projectId: epic.projectId },
      mode: modeToBe(projectIsOn(input.board, project), on),
    },
  ];
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
