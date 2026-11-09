import {
  boardState,
  parseLogins,
  projectState,
  stateOf,
  modeToBe,
  type AutopilotConfig,
  type AutopilotMode,
  type WhereInput,
  type WhereProject,
  type WhereState,
  type WhereTarget,
} from "@repo/contracts";
import type { HeaderLoss } from "./where.logic";

// Review PRs in the project table: two sources (task PRs and other people's), who counts as other people, and Approve,
// per project. The engine only looks at projects where the automation is on, so a project runs if either source is on
// and each source's switch writes the mode together with its own key. The board's keys are the All projects row, and
// a project stores a key only where it differs from the board (docs/features/autopilot.md#other-peoples-prs).

export type ReviewSource = "ownPrs" | "otherPrs";
const SOURCES: readonly ReviewSource[] = ["ownPrs", "otherPrs"];

/** The modes, and the config set at each scope. `board` includes the automation's defaults; `projects` is only what each sets. */
export interface ReviewPrsScopes {
  input: WhereInput;
  board: AutopilotConfig;
  projects: Readonly<Record<string, AutopilotConfig>>;
}

/** What one edit does at one scope. A config key set to undefined is removed, so the scope follows the board again. */
export interface ReviewPrsWrite {
  target: WhereTarget;
  mode?: AutopilotMode;
  config?: Record<string, unknown>;
}

type Sources = Record<ReviewSource, boolean>;

const isOn = (state: WhereState): boolean => state !== "off";

/** A source as the board's keys set it, whether or not the board itself runs. */
const boardSource = ({ board }: ReviewPrsScopes, source: ReviewSource): boolean =>
  source === "ownPrs" ? board.ownPrs !== false : board.otherPrs === true;

/** The boolean a project stores for `key`, or null where it follows the board. */
function ownFlag(scopes: ReviewPrsScopes, id: string, key: string): boolean | null {
  const value = scopes.projects[id]?.[key];
  return typeof value === "boolean" ? value : null;
}

const stateIn = (scopes: ReviewPrsScopes, id: string): WhereState => {
  const project = scopes.input.projects.find((p) => p.id === id);
  return project ? projectState(scopes.input.board, project) : "off";
};

/** Whether a source runs in this project: the automation is on there and the source isn't switched off. */
export function sourceOn(scopes: ReviewPrsScopes, id: string, source: ReviewSource): boolean {
  return isOn(stateIn(scopes, id)) && (ownFlag(scopes, id, source) ?? boardSource(scopes, source));
}

/** Whether a source runs for projects that follow the board: what the All projects row means for new ones. */
const boardSourceOn = (scopes: ReviewPrsScopes, source: ReviewSource): boolean =>
  isOn(boardState(scopes.input.board)) && boardSource(scopes, source);

const rowSources = (scopes: ReviewPrsScopes, id: string): Sources => ({
  ownPrs: sourceOn(scopes, id, "ownPrs"),
  otherPrs: sourceOn(scopes, id, "otherPrs"),
});

/** The board's state and source keys after an edit, which a project's writes are measured against. */
interface BoardAfter {
  state: WhereState;
  sources: Sources;
}

/** The writes that put one project on `target`, given the board it will sit under. */
function projectWrites(
  scopes: ReviewPrsScopes,
  after: BoardAfter,
  project: WhereProject,
  target: Sources,
): ReviewPrsWrite[] {
  const runs = target.ownPrs || target.otherPrs;
  const state = stateOf(project.mode, after.state);
  let mode: AutopilotMode | undefined;
  if (isOn(state) !== runs) mode = modeToBe(isOn(after.state), runs);
  // Its own On or Preview now only repeats the board.
  else if (runs && project.mode === after.state) mode = "inherit";

  const own = scopes.projects[project.id] ?? {};
  const config: Record<string, unknown> = {};
  for (const source of SOURCES) {
    // A project that is off holds nothing: its next switch writes both sources.
    const want = !runs || target[source] === after.sources[source] ? undefined : target[source];
    if (own[source] !== want) config[source] = want;
  }
  const hasConfig = Object.keys(config).length > 0;
  if (mode === undefined && !hasConfig) return [];
  return [
    {
      target: { kind: "project", id: project.id },
      ...(mode === undefined ? {} : { mode }),
      ...(hasConfig ? { config } : {}),
    },
  ];
}

/** One project's source switched: its mode (on if either source is) and both sources' keys. */
export function sourceRowWrites(
  scopes: ReviewPrsScopes,
  id: string,
  source: ReviewSource,
  on: boolean,
): ReviewPrsWrite[] {
  const project = scopes.input.projects.find((p) => p.id === id);
  if (!project) return [];
  const after: BoardAfter = {
    state: boardState(scopes.input.board),
    sources: { ownPrs: boardSource(scopes, "ownPrs"), otherPrs: boardSource(scopes, "otherPrs") },
  };
  return projectWrites(scopes, after, project, { ...rowSources(scopes, id), [source]: on });
}

/**
 * A source's header: the source on or off in every project, the other source staying as each row shows it. The board
 * goes first, so nothing is off on the way, then each project is put back on what it should show under the new board.
 * A project left with neither source also drops its epics' own On or Preview, as Off everywhere does.
 */
export function sourceHeaderWrites(
  scopes: ReviewPrsScopes,
  source: ReviewSource,
  on: boolean,
  mode: "on" | "preview",
): ReviewPrsWrite[] {
  const { input } = scopes;
  const current = boardState(input.board);
  const target: Sources = {
    ownPrs: boardSourceOn(scopes, "ownPrs"),
    otherPrs: boardSourceOn(scopes, "otherPrs"),
    [source]: on,
  };
  const runs = target.ownPrs || target.otherPrs;
  const after: BoardAfter = {
    state: !runs ? "off" : current !== "off" ? current : mode,
    // With nothing running the other source's key can stay as it is: only the column clicked is decided.
    sources: runs
      ? target
      : {
          ownPrs: source === "ownPrs" ? on : boardSource(scopes, "ownPrs"),
          otherPrs: source === "otherPrs" ? on : boardSource(scopes, "otherPrs"),
        },
  };
  const boardMode: AutopilotMode | undefined = runs === isOn(current) ? undefined : runs ? mode : "inherit";
  const config = {
    // Stored only where they differ from the automation's defaults, so an old board's row stays as it was.
    ownPrs: after.sources.ownPrs ? undefined : false,
    otherPrs: after.sources.otherPrs ? true : undefined,
  };
  const writes: ReviewPrsWrite[] = [
    { target: { kind: "board" }, ...(boardMode === undefined ? {} : { mode: boardMode }), config },
  ];
  for (const project of input.projects) {
    const next = { ...rowSources(scopes, project.id), [source]: on };
    writes.push(...projectWrites(scopes, after, project, next));
    if (next.ownPrs || next.otherPrs) continue;
    for (const epic of input.epics) {
      if (epic.projectId === project.id && (epic.mode === "on" || epic.mode === "preview")) {
        writes.push({ target: { kind: "epic", id: epic.id, projectId: project.id }, mode: "inherit" });
      }
    }
  }
  return writes;
}

/**
 * What a source's header click takes away, or null when it takes nothing a person set. Switching off drops a source a
 * project has on although the board doesn't give it (and epics' own On or Preview it would leave behind); turning on
 * drops the projects that keep it off on purpose: switched off themselves, or with the source off.
 */
export function sourceHeaderLoss(
  scopes: ReviewPrsScopes,
  shown: readonly string[],
  source: ReviewSource,
  turnOn: boolean,
): HeaderLoss | null {
  const titles = (ids: Set<string>) => scopes.input.projects.filter((p) => ids.has(p.id)).map((p) => p.title);
  if (turnOn) {
    const excluded = new Set(
      scopes.input.projects
        .filter((p) => shown.includes(p.id) && (p.mode === "off" || ownFlag(scopes, p.id, source) === false))
        .map((p) => p.id),
    );
    return excluded.size > 0 ? { projects: titles(excluded), epics: 0 } : null;
  }
  const own = new Set(shown.filter((id) => sourceOn(scopes, id, source) && !boardSourceOn(scopes, source)));
  const epics = scopes.input.epics.filter(
    (e) =>
      (e.mode === "on" || e.mode === "preview") &&
      !sourceOn(scopes, e.projectId, source === "ownPrs" ? "otherPrs" : "ownPrs"),
  );
  return own.size + epics.length > 0 ? { projects: titles(own), epics: epics.length } : null;
}

/** Whether Approve is on for this project, read where Others' is on (it has no effect elsewhere). */
export function approveOn(scopes: ReviewPrsScopes, id: string): boolean {
  return ownFlag(scopes, id, "otherApprove") ?? scopes.board.otherApprove === true;
}

/** One project's Approve, stored only where it differs from the board. */
export function approveRowWrite(scopes: ReviewPrsScopes, id: string, on: boolean): ReviewPrsWrite {
  const value = on === (scopes.board.otherApprove === true) ? undefined : on;
  return { target: { kind: "project", id }, config: { otherApprove: value } };
}

/** Approve's header: the board's value, every project following it again. */
export function approveHeaderWrites(scopes: ReviewPrsScopes, on: boolean): ReviewPrsWrite[] {
  return [
    { target: { kind: "board" }, config: { otherApprove: on ? true : undefined } },
    ...scopes.input.projects
      .filter((p) => ownFlag(scopes, p.id, "otherApprove") !== null)
      .map((p): ReviewPrsWrite => ({ target: { kind: "project", id: p.id }, config: { otherApprove: undefined } })),
  ];
}

/** The projects Approve's header click would override, among those that show it. */
export function approveHeaderLoss(
  scopes: ReviewPrsScopes,
  shown: readonly string[],
  turnOn: boolean,
): HeaderLoss | null {
  const projects = scopes.input.projects
    .filter((p) => shown.includes(p.id) && sourceOn(scopes, p.id, "otherPrs"))
    .filter((p) => ownFlag(scopes, p.id, "otherApprove") === !turnOn)
    .map((p) => p.title);
  return projects.length > 0 ? { projects, epics: 0 } : null;
}

export const boardPeople = (scopes: ReviewPrsScopes): string[] => parseLogins(scopes.board.otherAuthors);

/** Whether the project has its own list. */
export const hasOwnPeople = (scopes: ReviewPrsScopes, id: string): boolean =>
  typeof scopes.projects[id]?.otherAuthors === "string";

/** Who is reviewed in this project: its own list, or the board's. */
export function peopleIn(scopes: ReviewPrsScopes, id: string): string[] {
  return hasOwnPeople(scopes, id) ? parseLogins(scopes.projects[id]!.otherAuthors) : boardPeople(scopes);
}

const sameLogins = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** A project's list: it replaces the board's, and matching the board's again drops it. */
export function peopleRowWrite(scopes: ReviewPrsScopes, id: string, people: readonly string[]): ReviewPrsWrite {
  const value = sameLogins(people, boardPeople(scopes)) ? undefined : people.join(", ");
  return { target: { kind: "project", id }, config: { otherAuthors: value } };
}

/** Puts a project back on the board's list. */
export const peopleResetWrite = (id: string): ReviewPrsWrite => ({
  target: { kind: "project", id },
  config: { otherAuthors: undefined },
});

/** The board's list, which every project without its own follows. */
export const peopleBoardWrite = (people: readonly string[]): ReviewPrsWrite => ({
  target: { kind: "board" },
  config: { otherAuthors: people.join(", ") },
});

/** The list with `login` taken out if it is there, or added if it isn't. */
export const togglePerson = (people: readonly string[], login: string): string[] =>
  people.includes(login) ? people.filter((p) => p !== login) : [...people, login];

/** The names to offer: already used on the board, in this table or as the authors waiting for your approval. */
export function peopleRoster(scopes: ReviewPrsScopes, waiting: ReadonlyArray<string | null>): string[] {
  const lists = scopes.input.projects.map((p) => (hasOwnPeople(scopes, p.id) ? peopleIn(scopes, p.id) : []));
  const authors = waiting.flatMap((author) => (author ? [author.toLowerCase()] : []));
  return [...new Set([...boardPeople(scopes), ...lists.flat(), ...authors])];
}

/** Whether a row differs from All projects: counted for "N differ", and a dot on the row. */
export function reviewRowDiffers(scopes: ReviewPrsScopes, id: string): boolean {
  const state = stateIn(scopes, id);
  const board = boardState(scopes.input.board);
  if (isOn(state) && isOn(board) && state !== board) return true;
  if (SOURCES.some((source) => sourceOn(scopes, id, source) !== boardSourceOn(scopes, source))) return true;
  if (!sourceOn(scopes, id, "otherPrs")) return false;
  return approveOn(scopes, id) !== (scopes.board.otherApprove === true) || hasOwnPeople(scopes, id);
}

/** What projects added later get. */
export function reviewNewProjects(scopes: ReviewPrsScopes): string {
  const board = boardState(scopes.input.board);
  const word = (source: ReviewSource) =>
    boardSourceOn(scopes, source) ? (board === "preview" ? "in Preview" : "on") : "off";
  return `New projects: your PRs ${word("ownPrs")}, others' ${word("otherPrs")}.`;
}
