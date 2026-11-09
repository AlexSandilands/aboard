import { describe, expect, it } from "vitest";
import { resolveAutopilot, type AutopilotMode } from "./autopilot.ts";
import {
  applyWhereWrites,
  describeWhere,
  modeToBe,
  projectIsOn,
  whereEpic,
  whereEverywhere,
  whereInput,
  whereOffEverywhere,
  whereOnEverywhere,
  whereOwnOn,
  whereProject,
  whereProjectPreview,
  type AutopilotModeRow,
  type WhereDescription,
  type WhereInput,
  type WhereState,
  type WhereWrite,
} from "./autopilotWhere.ts";

const MODES: AutopilotMode[] = ["inherit", "on", "preview", "off"];
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

/** What the engine's own rule says about a task in the project (and epic): off, in Preview or on. */
function engineState(i: WhereInput, projectId: string, epicId?: string): WhereState {
  const project = i.projects.find((p) => p.id === projectId)!;
  const epic = i.epics.find((e) => e.id === epicId);
  const config = {};
  const resolved = resolveAutopilot([
    { scopeKind: "board", mode: i.board, config },
    { scopeKind: "project", mode: project.mode, config },
    epic ? { scopeKind: "epic", mode: epic.mode, config } : null,
  ]);
  return !resolved.enabled ? "off" : resolved.preview ? "preview" : "on";
}

const engineSays = (i: WhereInput, projectId: string, epicId?: string): boolean =>
  engineState(i, projectId, epicId) !== "off";

/** What the description alone says about the same task. */
function descriptionState(d: WhereDescription, projectId: string, epicId?: string): WhereState {
  const own = d.exceptions.find((e) => e.scope === "project" && e.id === projectId);
  const project: WhereState =
    d.reach === "everywhere"
      ? (own?.mode ?? d.state)
      : d.projects.includes(projectId)
        ? d.previewProjects.includes(projectId)
          ? "preview"
          : "on"
        : "off";
  const epic = d.exceptions.find((e) => e.scope === "epic" && e.id === epicId);
  return epic ? epic.mode : project;
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
              for (const p of PROJECTS) expect(descriptionState(d, p.id)).toBe(engineState(i, p.id));
              for (const e of EPICS) {
                expect(descriptionState(d, e.projectId, e.id)).toBe(engineState(i, e.projectId, e.id));
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
});

describe("Off everywhere", () => {
  it("leaves nothing running from any combination of modes, and keeps rows set Off", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        for (const e5 of MODES) {
          const before = input(board, { p1, p2: "on", p3: "off" }, { e5, e6: "preview" });
          const after = apply(before, whereOffEverywhere(before));
          for (const p of PROJECTS) expect(engineSays(after, p.id)).toBe(false);
          for (const e of EPICS) expect(engineSays(after, e.projectId, e.id)).toBe(false);
          expect(after.projects.find((p) => p.id === "p3")!.mode).toBe("off");
          expect(whereOwnOn(after)).toEqual({ projects: [], epics: [] });
        }
      }
    }
  });

  it("names the projects and epics that keep running when only the board goes off", () => {
    const own = whereOwnOn(input("on", { p1: "on", p2: "preview", p3: "off" }, { e6: "on" }));
    expect(own.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(own.epics.map((e) => e.id)).toEqual(["e6"]);
    expect(whereOffEverywhere(input("inherit"))).toEqual([]);
  });
});

describe("the table's header writes", () => {
  it("off clears epics set On too, whatever the projects did", () => {
    const before = input("off", { p1: "on", p2: "inherit" }, { e5: "on", e6: "preview" });
    const writes = whereOffEverywhere(before);
    expect(writes.filter((w) => w.target.kind === "epic").map((w) => w.mode)).toEqual(["inherit", "inherit"]);
    expect(whereOwnOn(apply(before, writes))).toEqual({ projects: [], epics: [] });
  });

  it("on leaves every project running, the board's Preview kept, from any combination", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        for (const p2 of MODES) {
          for (const e5 of MODES) {
            for (const e6 of MODES) {
              const before = input(board, { p1, p2 }, { e5, e6 });
              const boardBefore: WhereState = board === "on" || board === "preview" ? board : "off";
              const after = apply(before, whereOnEverywhere(before, "on"));
              const next: WhereState = boardBefore === "off" ? "on" : boardBefore;
              for (const p of PROJECTS) expect(engineState(after, p.id)).toBe(next);
              expect(after.projects.every((p) => p.mode === "inherit")).toBe(true);
              for (const e of EPICS) {
                const own = before.epics.find((x) => x.id === e.id)!.mode;
                // An epic's own setting still beats its project, unless it only repeated it.
                expect(engineState(after, e.projectId, e.id)).toBe(own === "inherit" ? next : own);
                expect(after.epics.find((x) => x.id === e.id)!.mode).toBe(own === next ? "inherit" : own);
              }
            }
          }
        }
      }
    }
  });

  it("on writes the board first, so a project that stays running is never off on the way", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        for (const p2 of MODES) {
          const before = input(board, { p1, p2 });
          const writes = whereOnEverywhere(before, "on");
          const boardOff = board === "off" || board === "inherit";
          expect(boardOff ? writes[0] : null).toEqual(boardOff ? { target: { kind: "board" }, mode: "on" } : null);
          for (let n = 1; n <= writes.length; n++) {
            const partial = apply(before, writes.slice(0, n));
            for (const p of PROJECTS) {
              expect(!engineSays(before, p.id) || engineSays(partial, p.id)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("on in Preview turns an off board on in Preview", () => {
    const after = apply(input("off", { p1: "off" }), whereOnEverywhere(input("off", { p1: "off" }), "preview"));
    expect(after.board).toBe("preview");
    for (const p of PROJECTS) expect(engineState(after, p.id)).toBe("preview");
  });

  it("on keeps the Off rows that whereEverywhere keeps for the Mode row", () => {
    const before = input("on", { p1: "off" });
    expect(apply(before, whereEverywhere(before)).projects.find((p) => p.id === "p1")!.mode).toBe("off");
    expect(apply(before, whereOnEverywhere(before)).projects.find((p) => p.id === "p1")!.mode).toBe("inherit");
  });
});

describe("a project's Preview switch", () => {
  it("gives the state asked for a running project, with no row when the board gives that", () => {
    for (const board of MODES) {
      for (const p1 of MODES) {
        const before = input(board, { p1 });
        const running = engineSays(before, "p1");
        for (const preview of [true, false]) {
          const writes = whereProjectPreview(before, "p1", preview);
          const after = apply(before, writes);
          const target: WhereState = preview ? "preview" : "on";
          // A project that is off has nothing to preview, so it gets no write and stays off.
          expect(engineState(after, "p1")).toBe(running ? target : "off");
          expect(running || writes.length === 0).toBe(true);
          const boardGives = board === target;
          const stored = after.projects.find((p) => p.id === "p1")!.mode;
          expect(writes.length === 0 || stored === (boardGives ? "inherit" : target)).toBe(true);
          // Asking again changes nothing.
          expect(whereProjectPreview(after, "p1", preview)).toEqual([]);
        }
      }
    }
  });

  it("does nothing for a project that isn't there", () => {
    expect(whereProjectPreview(input("on"), "nope", true)).toEqual([]);
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

describe("Preview", () => {
  it("reads a board in Preview as Preview, not On", () => {
    expect(describeWhere(input("preview")).sentence).toBe("Preview everywhere");
    expect(describeWhere(input("preview", { p2: "off" })).sentence).toBe("Preview everywhere except payments-api");
    expect(describeWhere(input("preview", { p1: "on" })).sentence).toBe("Preview everywhere; storefront On");
    expect(describeWhere(input("preview", {}, { e5: "off" })).sentence).toBe("Preview everywhere; epic #5 Off");
  });

  it("reads projects in Preview under Only in…", () => {
    expect(describeWhere(input("off", { p1: "preview" })).sentence).toBe("Preview only in storefront");
    const mixed = describeWhere(input("off", { p1: "on", p3: "preview" }));
    expect(mixed).toMatchObject({ reach: "only", projects: ["p1", "p3"], previewProjects: ["p3"] });
    expect(mixed.sentence).toBe("On only in storefront; Preview in docs");
  });

  it("counts an epic in Preview in a project that is off as running", () => {
    expect(describeWhere(input("inherit", {}, { e5: "preview" }))).toMatchObject({ reach: "nowhere", on: true });
  });

  it("Everywhere keeps a board's Preview, turns an off board on in the mode asked, and drops the Only in… rows", () => {
    expect(whereEverywhere(input("preview"))).toEqual([]);
    expect(whereEverywhere(input("inherit"))).toEqual([{ target: { kind: "board" }, mode: "on" }]);
    expect(whereEverywhere(input("inherit"), "preview")).toEqual([{ target: { kind: "board" }, mode: "preview" }]);
    const from = input("off", { p1: "preview" }, { e5: "preview" });
    const writes = whereEverywhere(from, "preview");
    expect(writes).toEqual([
      { target: { kind: "board" }, mode: "preview" },
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
      { target: { kind: "epic", id: "e5", projectId: "p1" }, mode: "inherit" },
    ]);
    expect(engineState(apply(from, writes), "p1")).toBe("preview");
  });

  it("switching a scope on or off leaves its Preview alone when it already follows the right way", () => {
    expect(whereProject(input("on", { p1: "preview" }), "p1", true)).toEqual([]);
    expect(whereProject(input("preview"), "p1", false)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "off" },
    ]);
    expect(whereProject(input("preview", { p1: "off" }), "p1", true)).toEqual([
      { target: { kind: "project", id: "p1" }, mode: "inherit" },
    ]);
  });
});
