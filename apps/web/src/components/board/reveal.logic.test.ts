import type { Project, TaskStatus, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { EpicBand, Lane, LaneCells } from "./board.logic";
import {
  advanceReveal,
  REVEAL_EXPIRY_MS,
  revealHiddenMessage,
  revealProgressFor,
  revealScrollTarget,
  revealStep,
} from "./reveal.logic";

const project = (id: string, collapsed = false): Project => ({
  id,
  title: id,
  workspaceRoot: null,
  workspaceKey: null,
  icon: null,
  t3ProjectId: null,
  planSkill: null,
  reviewSkill: null,
  position: id,
  collapsed,
  archivedAt: null,
  createdAt: "",
  updatedAt: "",
});

// Only the id is read.
const task = (id: string) => ({ id }) as TaskSummary;

function cells(byStatus: Partial<Record<TaskStatus, string[]>> = {}): LaneCells {
  const ids = (status: TaskStatus) => (byStatus[status] ?? []).map(task);
  return {
    backlog: ids("backlog"),
    planned: ids("planned"),
    in_progress: ids("in_progress"),
    review: ids("review"),
    done: ids("done"),
  };
}

const band = (id: string, byStatus: Partial<Record<TaskStatus, string[]>>): EpicBand => ({
  id,
  epic: task(id),
  cells: cells(byStatus),
  start: 0,
  end: 0,
});

const lane = (p: Project, parts: Partial<Lane> = {}): Lane => ({
  project: p,
  bands: [],
  cells: cells(),
  epicChildren: {},
  ...parts,
});

describe("revealStep", () => {
  it("shows a loose card", () => {
    const lanes = [lane(project("p"), { cells: cells({ planned: ["t"] }) })];
    expect(revealStep(lanes, "t", {})).toEqual({ kind: "show" });
  });

  it("is hidden when no lane has the card, as when a filter leaves it out", () => {
    const lanes = [lane(project("p"), { cells: cells({ planned: ["other"] }) })];
    expect(revealStep(lanes, "t", {})).toEqual({ kind: "hidden" });
    expect(revealStep([], "t", {})).toEqual({ kind: "hidden" });
  });

  it("expands a collapsed lane first", () => {
    const p = project("p", true);
    const lanes = [lane(p, { cells: cells({ planned: ["t"] }) })];
    expect(revealStep(lanes, "t", {})).toEqual({ kind: "expand-lane", project: p });
  });

  it("expands a collapsed lane for a card in an epic band or a finished epic", () => {
    const p = project("p", true);
    expect(revealStep([lane(p, { bands: [band("e", { planned: ["t"] })] })], "t", {})).toEqual({
      kind: "expand-lane",
      project: p,
    });
    expect(revealStep([lane(p, { epicChildren: { e: [task("t")] } })], "t", {})).toEqual({
      kind: "expand-lane",
      project: p,
    });
  });

  it("expands a folded epic band, but not for the epic's own header", () => {
    const lanes = [lane(project("p"), { bands: [band("e", { planned: ["t"] })] })];
    expect(revealStep(lanes, "t", { e: true })).toEqual({ kind: "expand-band", epicId: "e" });
    expect(revealStep(lanes, "e", { e: true })).toEqual({ kind: "show" });
    expect(revealStep(lanes, "t", {})).toEqual({ kind: "show" });
  });

  it("shows a card inside a finished epic's card", () => {
    const lanes = [lane(project("p"), { cells: cells({ done: ["e"] }), epicChildren: { e: [task("t")] } })];
    expect(revealStep(lanes, "t", {})).toEqual({ kind: "show" });
  });

  it("shows a card in the priority lane, which never folds", () => {
    const lanes = [lane(project("priority"), { priority: true, cells: cells({ in_progress: ["t"] }) })];
    expect(revealStep(lanes, "t", {})).toEqual({ kind: "show" });
  });
});

describe("revealScrollTarget", () => {
  const view = { top: 36, left: 0, bottom: 636, right: 1000 };
  const scroll = { top: 100, left: 20 };

  it("leaves a card that is fully in view alone", () => {
    expect(revealScrollTarget(view, { top: 200, left: 100, bottom: 300, right: 340 }, scroll)).toBeNull();
  });

  it("centres a card below the view, vertically only", () => {
    // Card centre at 950, view centre at 336: scroll down by the difference.
    expect(revealScrollTarget(view, { top: 900, left: 100, bottom: 1000, right: 340 }, scroll)).toEqual({
      top: 100 + 614,
      left: 20,
    });
  });

  it("scrolls up and across for a card above and right of the view", () => {
    expect(revealScrollTarget(view, { top: -400, left: 1200, bottom: -300, right: 1440 }, scroll)).toEqual({
      top: 100 + (-350 - 336),
      left: 20 + (1320 - 500),
    });
  });

  it("treats a card under the sticky header as out of view", () => {
    expect(revealScrollTarget(view, { top: 10, left: 100, bottom: 110, right: 340 }, scroll)?.top).toBeLessThan(100);
  });

  it("aligns the start of a card taller than the view", () => {
    expect(revealScrollTarget(view, { top: 700, left: 100, bottom: 1500, right: 340 }, scroll)).toEqual({
      top: 100 + 664,
      left: 20,
    });
  });
});

describe("advanceReveal", () => {
  const p = project("p");
  const shown = [lane(p, { cells: cells({ planned: ["t"] }) })];
  const base = {
    taskId: "t",
    age: 0,
    lanes: shown,
    collapsedEpics: {},
    expanded: new Set<string>(),
    selectedTaskId: "t",
    cardDrawn: () => true,
  };

  it("scrolls once the task is open and its card is drawn", () => {
    expect(advanceReveal(base)).toEqual({ kind: "scroll" });
  });

  it("waits until the task is the open one, and until its card is drawn", () => {
    expect(advanceReveal({ ...base, selectedTaskId: null })).toEqual({ kind: "wait" });
    expect(advanceReveal({ ...base, selectedTaskId: "other" })).toEqual({ kind: "wait" });
    expect(advanceReveal({ ...base, cardDrawn: () => false })).toEqual({ kind: "wait" });
  });

  it("drops a request that expired, even with the card on screen", () => {
    expect(advanceReveal({ ...base, age: REVEAL_EXPIRY_MS + 1 })).toEqual({ kind: "drop", reason: "expired" });
    expect(advanceReveal({ ...base, age: REVEAL_EXPIRY_MS })).toEqual({ kind: "scroll" });
  });

  it("drops a request for a card the filters leave out, and says it is hidden", () => {
    expect(advanceReveal({ ...base, lanes: [lane(p)] })).toEqual({ kind: "drop", reason: "hidden" });
  });

  it("expands what hides the card once, then waits for the board to show it", () => {
    const folded = project("p", true);
    const lanes = [lane(folded, { cells: cells({ planned: ["t"] }) })];
    expect(advanceReveal({ ...base, lanes })).toEqual({ kind: "expand-lane", project: folded });
    // The update was refused (the lane is still folded): no second try, no scroll.
    expect(advanceReveal({ ...base, lanes, expanded: new Set(["p"]) })).toEqual({ kind: "wait" });

    const bands = [lane(p, { bands: [band("e", { planned: ["t"] })] })];
    expect(advanceReveal({ ...base, lanes: bands, collapsedEpics: { e: true } })).toEqual({
      kind: "expand-band",
      epicId: "e",
    });
    expect(advanceReveal({ ...base, lanes: bands, collapsedEpics: { e: true }, expanded: new Set(["e"]) })).toEqual({
      kind: "wait",
    });
  });

  it("only looks for the card once everything else is in place", () => {
    let looked = false;
    advanceReveal({
      ...base,
      selectedTaskId: null,
      cardDrawn: () => {
        looked = true;
        return true;
      },
    });
    expect(looked).toBe(false);
  });
});

describe("revealHiddenMessage", () => {
  it("blames the filters for a task on the board snapshot and stays neutral for one that isn't", () => {
    expect(revealHiddenMessage(42)).toBe("The filters hide #42.");
    expect(revealHiddenMessage(undefined)).toBe(
      "This task isn't on the board. Archived tasks only show when Show archived is on.",
    );
  });
});

describe("revealProgressFor", () => {
  it("keeps the progress of the same request, so an expansion isn't repeated", () => {
    const first = revealProgressFor(null, 1);
    first.expanded.add("p");
    expect(revealProgressFor(first, 1)).toBe(first);
  });

  it("starts fresh for a new request, even for the same task", () => {
    const first = revealProgressFor(null, 1);
    first.expanded.add("p");
    const next = revealProgressFor(first, 2);
    expect(next).not.toBe(first);
    expect(next).toEqual({ nonce: 2, expanded: new Set() });
  });
});
