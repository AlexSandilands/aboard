import { describe, expect, it } from "vitest";
import { resolveAutopilot, type AutopilotMode } from "./autopilot.ts";
import {
  applyWhereWrites,
  currentOnProjects,
  describeWhere,
  modeToBe,
  projectIsOn,
  whereAddException,
  whereCandidates,
  whereEpic,
  whereEverywhere,
  whereInput,
  whereOnlyIn,
  whereProject,
  whereRemoveException,
  type AutopilotModeRow,
  type WhereDescription,
  type WhereInput,
  type WhereWrite,
} from "./autopilotWhere.ts";

const MODES: AutopilotMode[] = ["inherit", "on", "off"];
const PROJECTS = [
  { id: "p1", title: "storefront" },
  { id: "p2", title: "payments-api" },
  { id: "p3", title: "docs" },
  { id: "p4", title: "infra" },
];
const EPICS = [
  { id: "e5", number: 5, projectId: "p1" },
  { id: "e6", number: 6, projectId: "p2" },
];

const input = (
  board: AutopilotMode,
  projects: Partial<Record<string, AutopilotMode>> = {},
  epics: Partial<Record<string, AutopilotMode>> = {},
): WhereInput => ({
  board,
  projects: PROJECTS.map((p) => ({ ...p, mode: projects[p.id] ?? "inherit" })),
  epics: EPICS.map((e) => ({ ...e, mode: epics[e.id] ?? "inherit" })),
});

/** What the engine's own rule says about a task in the project (and epic). */
function engineSays(i: WhereInput, projectId: string, epicId?: string): boolean {
  const project = i.projects.find((p) => p.id === projectId)!;
  const epic = i.epics.find((e) => e.id === epicId);
  const config = {};
  return resolveAutopilot([
    { scopeKind: "board", mode: i.board, config },
    { scopeKind: "project", mode: project.mode, config },
    epic ? { scopeKind: "epic", mode: epic.mode, config } : null,
  ]).enabled;
}

/** What the description alone says about the same task. */
function descriptionSays(d: WhereDescription, projectId: string, epicId?: string): boolean {
  const projectOn =
    d.reach === "everywhere"
      ? !d.exceptions.some((e) => e.scope === "project" && e.id === projectId)
      : d.projects.includes(projectId);
  const epic = d.exceptions.find((e) => e.scope === "epic" && e.id === epicId);
  return epic ? epic.mode === "on" : projectOn;
}

/** The input after the writes, as the server would store them. */
function apply(i: WhereInput, writes: readonly WhereWrite[]): WhereInput {
  const next: WhereInput = {
    board: i.board,
    projects: i.projects.map((p) => ({ ...p })),
    epics: i.epics.map((e) => ({ ...e })),
  };
  for (const { target, mode } of writes) {
    if (target.kind === "board") next.board = mode;
    else if (target.kind === "project") next.projects.find((p) => p.id === target.id)!.mode = mode;
    else next.epics.find((e) => e.id === target.id)!.mode = mode;
  }
  return next;
}

/** Whether two inputs run in the same places, for every project and epic. */
function sameReach(a: WhereInput, b: WhereInput): boolean {
  return (
    PROJECTS.every((p) => engineSays(a, p.id) === engineSays(b, p.id)) &&
    EPICS.every((e) => engineSays(a, e.projectId, e.id) === engineSays(b, e.projectId, e.id))
  );
}

describe("describeWhere", () => {
  it("reads the switches table's rows", () => {
    // Board, project, epic: every row of the table in docs/features/autopilot.md.
    const one = (board: AutopilotMode, project: AutopilotMode, epic: AutopilotMode) =>
      describeWhere({
        board,
        projects: [{ id: "p1", title: "storefront", mode: project }],
        epics: [{ id: "e5", number: 5, projectId: "p1", mode: epic }],
      });
    expect(one("inherit", "inherit", "inherit").sentence).toBe("Off everywhere");
    expect(one("on", "inherit", "inherit").sentence).toBe("On everywhere");
    expect(one("on", "off", "inherit").sentence).toBe("On everywhere except storefront");
    expect(one("off", "on", "inherit").sentence).toBe("On only in storefront");
    expect(one("off", "off", "on").sentence).toBe("Off everywhere; epic #5 On");
    expect(one("on", "on", "off").sentence).toBe("On everywhere; epic #5 Off");
  });

  it("says what the issue's example does", () => {
    expect(describeWhere(input("on", { p2: "off" }, { e5: "off" })).sentence).toBe(
      "On everywhere except payments-api; epic #5 Off",
    );
  });

  it("describes each reach and lists the exceptions", () => {
    expect(describeWhere(input("on"))).toMatchObject({ reach: "everywhere", on: true, exceptions: [] });
    expect(describeWhere(input("on", { p2: "off", p3: "off" })).exceptions).toEqual([
      { scope: "project", id: "p2", label: "payments-api", mode: "off" },
      { scope: "project", id: "p3", label: "docs", mode: "off" },
    ]);
    expect(describeWhere(input("off", { p1: "on", p3: "on" }))).toMatchObject({
      reach: "only",
      projects: ["p1", "p3"],
      sentence: "On only in storefront, docs",
    });
    expect(describeWhere(input("inherit"))).toMatchObject({ reach: "nowhere", on: false });
    // The stored Off at the board reads like no row.
    expect(describeWhere(input("off")).sentence).toBe("Off everywhere");
    // An epic switched on in an off project still runs.
    expect(describeWhere(input("inherit", {}, { e5: "on" }))).toMatchObject({ reach: "nowhere", on: true });
  });

  it("leaves out an epic that is set the same as its project", () => {
    expect(describeWhere(input("on", {}, { e5: "on" })).exceptions).toEqual([]);
    expect(describeWhere(input("off", { p1: "on" }, { e5: "on" })).sentence).toBe("On only in storefront");
    expect(describeWhere(input("inherit", {}, { e5: "off" })).sentence).toBe("Off everywhere");
  });

  it("shortens a long list of projects", () => {
    expect(describeWhere(input("off", { p1: "on", p2: "on", p3: "on", p4: "on" })).sentence).toBe(
      "On only in storefront, payments-api, docs and 1 more",
    );
  });

  it("agrees with resolveAutopilot for every combination of modes", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        for (const p2 of MODES) {
          for (const e5 of MODES) {
            for (const e6 of MODES) {
              const i = input(board, { p1, p2 }, { e5, e6 });
              const d = describeWhere(i);
              for (const p of PROJECTS) expect(descriptionSays(d, p.id)).toBe(engineSays(i, p.id));
              for (const e of EPICS) {
                expect(descriptionSays(d, e.projectId, e.id)).toBe(engineSays(i, e.projectId, e.id));
              }
              // `on` is true exactly when the automation runs somewhere.
              const anywhere =
                PROJECTS.some((p) => engineSays(i, p.id)) || EPICS.some((e) => engineSays(i, e.projectId, e.id));
              expect(d.on).toBe(anywhere);
            }
          }
        }
      }
    }
  });
});

describe("whereInput", () => {
  it("reads one automation's modes from the stored rows, Inherit where there is none", () => {
    const rows: AutopilotModeRow[] = [
      { scopeKind: "board", scopeId: null, automation: "a", mode: "on" },
      { scopeKind: "project", scopeId: "p2", automation: "a", mode: "off" },
      { scopeKind: "epic", scopeId: "e5", automation: "a", mode: "off" },
      { scopeKind: "project", scopeId: "p1", automation: "other", mode: "off" },
    ];
    expect(whereInput(rows, "a", PROJECTS, EPICS)).toEqual(input("on", { p2: "off" }, { e5: "off" }));
    expect(whereInput([], "a", PROJECTS, EPICS)).toEqual(input("inherit"));
  });
});

describe("edits", () => {
  it("Everywhere switches the board on and drops the rows Only in… left, so Off projects are the exceptions", () => {
    const from = input("inherit", { p1: "on", p2: "off" }, { e5: "on", e6: "off" });
    const writes = whereEverywhere(from);
    expect(writes).toEqual([
      { target: { kind: "board" }, mode: "on" },
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "inherit" },
      { target: { kind: "epic", id: "e6", projectId: "p2" }, mode: "inherit" },
    ]);
    // An epic set the same as its project (On in a project that is on, Off in one that is Off) is no exception.
    expect(describeWhere(apply(from, writes)).sentence).toBe("On everywhere except payments-api");
    expect(whereEverywhere(input("on"))).toEqual([]);
  });

  it("Everywhere then Switch off (the board back to Inherit) runs nowhere", () => {
    const only = input("off", { p1: "on", p3: "on" }, { e5: "on" });
    const everywhere = apply(only, whereEverywhere(only));
    const off = apply(everywhere, [{ target: { kind: "board" }, mode: "inherit" }]);
    for (const p of PROJECTS) expect(engineSays(off, p.id)).toBe(false);
    for (const e of EPICS) expect(engineSays(off, e.projectId, e.id)).toBe(false);
  });

  it("Only in… turns the picked projects on, then the board off, then the others that were on back to Inherit", () => {
    const from = input("on", { p2: "off" });
    const writes = whereOnlyIn(from, currentOnProjects(from));
    expect(writes).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "on" },
      { target: { kind: "project", id: "p3" }, mode: "on" },
      { target: { kind: "project", id: "p4" }, mode: "on" },
      { target: { kind: "board" }, mode: "inherit" },
    ]);
    // Everywhere except payments-api, as Only in the rest: nothing changes where it runs.
    expect(sameReach(from, apply(from, writes))).toBe(true);

    const only = input("off", { p1: "on", p3: "on" });
    expect(whereOnlyIn(only, ["p3", "p4"])).toEqual([
      { target: { kind: "project", id: "p4" }, mode: "on" },
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
    ]);
    expect(describeWhere(apply(only, whereOnlyIn(only, ["p3", "p4"]))).sentence).toBe("On only in docs, infra");
    // Nothing picked: it runs nowhere.
    expect(describeWhere(apply(only, whereOnlyIn(only, []))).reach).toBe("nowhere");
    // No board write when it is already off.
    expect(whereOnlyIn(input("off"), ["p1"]).some((w) => w.target.kind === "board")).toBe(false);
  });

  it("never switches a project that stays on off along the way, each write being a request of its own", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        for (const p2 of MODES) {
          for (const e5 of MODES) {
            const from = input(board, { p1, p2 }, { e5 });
            const stays = currentOnProjects(from);
            for (const writes of [whereOnlyIn(from, stays), whereEverywhere(from)]) {
              let step = from;
              for (const write of writes) {
                step = apply(step, [write]);
                for (const id of stays) expect(engineSays(step, id)).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("switches a project or epic so that it needs no row of its own when the scope above gives that", () => {
    expect(modeToBe(true, true)).toBe("inherit");
    expect(modeToBe(true, false)).toBe("off");
    expect(modeToBe(false, true)).toBe("on");
    expect(modeToBe(false, false)).toBe("inherit");
    expect(projectIsOn("on", { mode: "inherit" })).toBe(true);
    expect(projectIsOn("inherit", { mode: "inherit" })).toBe(false);

    expect(whereProject(input("on"), "p1", false)).toEqual([{ target: { kind: "project", id: "p1" }, mode: "off" }]);
    expect(whereProject(input("on", { p1: "off" }), "p1", true)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
    ]);
    expect(whereProject(input("off", { p1: "on" }), "p1", false)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
    ]);
    expect(whereProject(input("on"), "p1", true)).toEqual([]);
    expect(whereProject(input("on"), "missing", true)).toEqual([]);

    expect(whereEpic(input("on"), "e5", false)).toEqual([
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "off" },
    ]);
    // The epic's project is off, so a switch on is an override; and one that follows again is Inherit.
    expect(whereEpic(input("inherit"), "e5", true)).toEqual([
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "on" },
    ]);
    expect(whereEpic(input("on", { p1: "off" }, { e5: "on" }), "e5", false)).toEqual([
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "inherit" },
    ]);
  });

  it("offers the projects not yet off while it runs everywhere, and the epics that aren't exceptions", () => {
    expect(whereCandidates(input("on", { p2: "off" }, { e5: "off" }))).toEqual([
      { scope: "project", id: "p1", label: "storefront", mode: "off" },
      { scope: "project", id: "p3", label: "docs", mode: "off" },
      { scope: "project", id: "p4", label: "infra", mode: "off" },
      { scope: "epic", id: "e6", label: "epic #6", mode: "on", projectId: "p2" },
    ]);
    // Under Only in… projects are chips; an epic is offered the opposite of its project's state.
    expect(whereCandidates(input("off", { p1: "on" }))).toEqual([
      { scope: "epic", id: "e5", label: "epic #5", mode: "off", projectId: "p1" },
      { scope: "epic", id: "e6", label: "epic #6", mode: "on", projectId: "p2" },
    ]);
  });

  it("adds and removes an exception through the same rows resolveAutopilot reads", () => {
    const base = input("on");
    const [candidate] = whereCandidates(base);
    const added = apply(base, whereAddException(candidate!));
    expect(describeWhere(added).sentence).toBe("On everywhere except storefront");
    expect(engineSays(added, "p1")).toBe(false);

    const [exception] = describeWhere(added).exceptions;
    const removed = apply(added, whereRemoveException(added, exception!));
    expect(describeWhere(removed).sentence).toBe("On everywhere");

    const epicAdded = apply(base, whereAddException({ scope: "epic", id: "e6", mode: "off", projectId: "p2" }));
    expect(describeWhere(epicAdded).sentence).toBe("On everywhere; epic #6 Off");
    expect(describeWhere(apply(epicAdded, whereRemoveException(epicAdded, { scope: "epic", id: "e6" }))).sentence).toBe(
      "On everywhere",
    );
    expect(whereAddException({ scope: "epic", id: "e6", mode: "off" })).toEqual([]);
    expect(whereRemoveException(base, { scope: "epic", id: "gone" })).toEqual([]);
  });

  it("keeps where it runs the same under any single edit followed by its undo", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        for (const e5 of MODES) {
          const i = input(board, { p1 }, { e5 });
          const d = describeWhere(i);
          // Remove every exception, then put each back: the places it runs are unchanged.
          let cleared = i;
          for (const ex of d.exceptions) cleared = apply(cleared, whereRemoveException(cleared, ex));
          for (const ex of d.exceptions) {
            const back = whereCandidates(cleared).find((c) => c.id === ex.id && c.scope === ex.scope);
            if (back) cleared = apply(cleared, whereAddException(back));
          }
          expect(sameReach(i, cleared)).toBe(true);
        }
      }
    }
  });
});

describe("applyWhereWrites", () => {
  it("sets, changes and drops rows of one automation and leaves the others alone", () => {
    const rows: AutopilotModeRow[] = [
      { scopeKind: "board", scopeId: null, automation: "a", mode: "on" },
      { scopeKind: "project", scopeId: "p1", automation: "a", mode: "off" },
      { scopeKind: "project", scopeId: "p1", automation: "other", mode: "off" },
    ];
    const next = applyWhereWrites(rows, "a", [
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "off" },
      { target: { kind: "board" }, mode: "off" },
    ]);
    expect(next).toEqual([
      { scopeKind: "project", scopeId: "p1", automation: "other", mode: "off" },
      { scopeKind: "epic", scopeId: "e5", automation: "a", mode: "off" },
      { scopeKind: "board", scopeId: null, automation: "a", mode: "off" },
    ]);
    expect(rows).toHaveLength(3);
  });
});
