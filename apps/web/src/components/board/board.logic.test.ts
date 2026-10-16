import type { BoardSnapshot, Project, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  attentionTasks,
  buildLanes,
  columnCounts,
  COLUMN_PREVIEW_COUNT,
  findRow,
  laneHasCollapsibleCell,
  matchesTaskSearch,
  openTaskCounts,
  reuseUnchangedLanes,
  rowIndex,
  visibleCellTasks,
} from "./board.logic";

function project(id: string): Project {
  return {
    id,
    title: id,
    workspaceRoot: null,
    workspaceKey: null,
    icon: null,
    t3ProjectId: null,
    reviewSkill: null,
    position: id,
    collapsed: false,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

function task(id: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id,
    number: 1,
    projectId: "p",
    kind: "task",
    parent: null,
    rollup: null,
    title: id,
    status: "backlog",
    position: "a0",
    archivedAt: null,
    createdBy: "user",
    createdAt: "",
    updatedAt: "",
    statusChangedAt: "",
    labels: [],
    blockedBy: [],
    blocks: [],
    blocked: false,
    resolution: null,
    resolvedBy: null,
    progress: { done: 0, total: 0 },
    stepStatuses: [],
    currentStep: null,
    links: [],
    attention: [],
    lastNote: null,
    autoReview: null,
    review: null,
    suggestedModel: null,
    import: null,
    ...overrides,
  };
}

function board(tasks: TaskSummary[], projects = [project("p"), project("q")]): BoardSnapshot {
  return {
    projects,
    tasks,
    labelColors: {},
    integrations: {
      t3: { detected: false, origin: null, environmentId: null, label: null, liveStatus: "off", error: null },
    },
  };
}

const noFilters = { projectId: null, search: "", attentionOnly: false, hasPrOnly: false, labels: [] };

describe("matchesTaskSearch", () => {
  const jira = task("t", {
    number: 42,
    title: "Fix login redirect",
    links: [
      {
        id: "l",
        taskId: "t",
        url: "",
        label: null,
        syncedAt: null,
        createdAt: "",
        kind: "jira",
        ref: { key: "ABC-123" },
      },
    ],
  });

  it("matches title, number and Jira key", () => {
    expect(matchesTaskSearch(jira, "login")).toBe(true);
    expect(matchesTaskSearch(jira, "#42")).toBe(true);
    expect(matchesTaskSearch(jira, "4")).toBe(true);
    expect(matchesTaskSearch(jira, "abc-1")).toBe(true);
    expect(matchesTaskSearch(jira, "#43")).toBe(false);
    expect(matchesTaskSearch(jira, "logout")).toBe(false);
    expect(matchesTaskSearch(jira, "  ")).toBe(true);
  });

  it("matches labels", () => {
    expect(matchesTaskSearch(task("t", { labels: ["backend"] }), "back")).toBe(true);
  });
});

describe("buildLanes", () => {
  it("groups tasks by project and status, ordering by position and Done by recency", () => {
    const lanes = buildLanes(
      board([
        task("b", { position: "a2" }),
        task("a", { position: "a1" }),
        task("old", { status: "done", statusChangedAt: "2026-01-01" }),
        task("new", { status: "done", statusChangedAt: "2026-02-01" }),
        task("other", { projectId: "q" }),
      ]),
      noFilters,
    );
    expect(lanes.map((l) => l.project.id)).toEqual(["p", "q"]);
    expect(lanes[0]!.cells.backlog.map((t) => t.id)).toEqual(["a", "b"]);
    expect(lanes[0]!.cells.done.map((t) => t.id)).toEqual(["new", "old"]);
    expect(lanes[1]!.cells.backlog.map((t) => t.id)).toEqual(["other"]);
  });

  it("scopes to a project and keeps empty lanes unless filtering", () => {
    expect(buildLanes(board([]), { ...noFilters, projectId: "q" }).map((l) => l.project.id)).toEqual(["q"]);
    expect(buildLanes(board([]), { ...noFilters, projectId: "missing" })).toHaveLength(2);
    expect(buildLanes(board([task("x")]), { ...noFilters, search: "x" }).map((l) => l.project.id)).toEqual(["p"]);
  });

  it("keeps tasks with any of the selected labels and drops lanes without one", () => {
    const ui = task("ui", { position: "a1", labels: ["ui"] });
    const server = task("server", { position: "a2", labels: ["server", "bug"] });
    const lanes = buildLanes(board([ui, server, task("plain"), task("docs", { projectId: "q", labels: ["docs"] })]), {
      ...noFilters,
      labels: ["ui", "bug"],
    });
    expect(lanes.map((l) => l.project.id)).toEqual(["p"]);
    expect(lanes[0]!.cells.backlog.map((t) => t.id)).toEqual(["ui", "server"]);
  });

  it("filters to tasks needing attention", () => {
    const flagged = task("flagged", { attention: [{ kind: "blocked_step", severity: "warning", message: "Blocked" }] });
    const lanes = buildLanes(board([flagged, task("calm")]), { ...noFilters, attentionOnly: true });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.cells.backlog).toEqual([flagged]);
  });

  it("filters to tasks with a PR link", () => {
    const withPr = task("pr", {
      links: [
        {
          id: "l",
          taskId: "pr",
          url: "",
          label: null,
          syncedAt: null,
          createdAt: "",
          kind: "pr",
          ref: null,
          snapshot: null,
        },
      ],
    });
    const lanes = buildLanes(board([withPr, task("none"), task("q-none", { projectId: "q" })]), {
      ...noFilters,
      hasPrOnly: true,
    });
    expect(lanes.map((l) => l.project.id)).toEqual(["p"]);
    expect(lanes[0]!.cells.backlog).toEqual([withPr]);
  });

  it("merges archived tasks into their lanes, preferring the snapshot copy", () => {
    const live = task("live");
    const archived = task("old", { archivedAt: "2026-01-01", position: "a1" });
    const stale = { ...live, archivedAt: "2026-01-01" };
    const lanes = buildLanes(board([live]), noFilters, [archived, stale]);
    expect(lanes[0]!.cells.backlog).toEqual([live, archived]);
  });
});

describe("reuseUnchangedLanes", () => {
  it("keeps identities for untouched lanes and cells", () => {
    const a = task("a");
    const b = task("b", { projectId: "q" });
    const projects = [project("p"), project("q")];
    const first = buildLanes(board([a, b], projects), noFilters);
    const changedB = { ...b, title: "changed" };
    const second = reuseUnchangedLanes(first, buildLanes(board([a, changedB], projects), noFilters));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]!.cells.planned).toBe(first[1]!.cells.planned);
    expect(second[1]!.cells.backlog).toEqual([changedB]);
  });
});

describe("attentionTasks", () => {
  it("puts errors first", () => {
    const warn = task("warn", {
      updatedAt: "2026-03-01",
      attention: [{ kind: "pr_conflict", severity: "warning", message: "" }],
    });
    const err = task("err", {
      updatedAt: "2026-01-01",
      attention: [{ kind: "thread_failed", severity: "error", message: "" }],
    });
    expect(attentionTasks([warn, task("calm"), err]).map((t) => t.id)).toEqual(["err", "warn"]);
  });
});

describe("visibleCellTasks", () => {
  const tasks = Array.from({ length: COLUMN_PREVIEW_COUNT + 3 }, (_, i) => task(`t${i}`));
  const ids = (list: ReadonlyArray<TaskSummary>) => list.map((t) => t.id);

  it("shows every card when the column is expanded", () => {
    expect(visibleCellTasks(tasks, false, [])).toEqual({ visible: tasks, hiddenCount: 0 });
  });

  it("shows every card when a collapsed cell is within the preview", () => {
    const few = tasks.slice(0, COLUMN_PREVIEW_COUNT);
    expect(visibleCellTasks(few, true, [])).toEqual({ visible: few, hiddenCount: 0 });
  });

  it("truncates a collapsed cell to the preview", () => {
    const result = visibleCellTasks(tasks, true, [null]);
    expect(ids(result.visible)).toEqual(ids(tasks.slice(0, COLUMN_PREVIEW_COUNT)));
    expect(result.hiddenCount).toBe(3);
  });

  it("keeps the selected card visible when it is past the preview", () => {
    const selected = tasks[COLUMN_PREVIEW_COUNT + 1]!;
    const result = visibleCellTasks(tasks, true, [selected.id]);
    expect(ids(result.visible)).toEqual([...ids(tasks.slice(0, COLUMN_PREVIEW_COUNT)), selected.id]);
    expect(result.hiddenCount).toBe(2);
  });

  it("keeps several cards visible in cell order", () => {
    const dragged = tasks[COLUMN_PREVIEW_COUNT]!;
    const selected = tasks[COLUMN_PREVIEW_COUNT + 2]!;
    const result = visibleCellTasks(tasks, true, [selected.id, dragged.id]);
    expect(ids(result.visible).slice(COLUMN_PREVIEW_COUNT)).toEqual([dragged.id, selected.id]);
    expect(result.hiddenCount).toBe(1);
  });

  it("does not duplicate a selected card already in the preview", () => {
    const result = visibleCellTasks(tasks, true, [tasks[0]!.id]);
    expect(result.visible).toHaveLength(COLUMN_PREVIEW_COUNT);
    expect(result.hiddenCount).toBe(3);
  });
});

describe("laneHasCollapsibleCell", () => {
  const empty = { backlog: [], planned: [], in_progress: [], review: [], done: [] };
  const many = Array.from({ length: COLUMN_PREVIEW_COUNT + 1 }, (_, i) => task(`t${i}`));

  it("is true when any cell has more cards than the preview", () => {
    expect(laneHasCollapsibleCell({ ...empty, review: many })).toBe(true);
  });

  it("is false when every cell fits in the preview", () => {
    expect(laneHasCollapsibleCell({ ...empty, done: many.slice(0, COLUMN_PREVIEW_COUNT) })).toBe(false);
  });
});

describe("epic bands", () => {
  const epic = (id: string, overrides: Partial<TaskSummary> = {}) => task(id, { kind: "epic", ...overrides });
  const child = (id: string, epicId: string, overrides: Partial<TaskSummary> = {}) =>
    task(id, { parent: { id: epicId, number: 1, title: epicId }, ...overrides });
  const ids = (cells: ReadonlyArray<TaskSummary>) => cells.map((t) => t.id);

  it("puts an epic's children in its band, spanning their first to last column", () => {
    const [lane] = buildLanes(
      board([
        epic("e"),
        child("a", "e", { status: "planned" }),
        child("b", "e", { status: "review" }),
        task("loose", { status: "planned" }),
      ]),
      { ...noFilters, projectId: "p" },
    );
    expect(lane!.bands).toHaveLength(1);
    const band = lane!.bands[0]!;
    expect(band).toMatchObject({ id: "e", start: 1, end: 3 });
    expect(ids(band.cells.planned)).toEqual(["a"]);
    expect(ids(band.cells.review)).toEqual(["b"]);
    // Epics aren't cards, and children aren't loose.
    expect(ids(lane!.cells.planned)).toEqual(["loose"]);
    expect(ids(lane!.cells.backlog)).toEqual([]);
  });

  it("shows an empty epic in Backlog and stacks bands oldest epic first, whatever their column positions", () => {
    const late = epic("late", { number: 9, position: "a1" });
    const [lane] = buildLanes(board([late, epic("early", { number: 2, position: "a2" })]), {
      ...noFilters,
      projectId: "p",
    });
    expect(lane!.bands.map((b) => [b.id, b.start, b.end])).toEqual([
      ["early", 0, 0],
      ["late", 0, 0],
    ]);
  });

  it("leaves children loose when their epic isn't on the board", () => {
    const [lane] = buildLanes(board([child("a", "gone")]), { ...noFilters, projectId: "p" });
    expect(lane!.bands).toEqual([]);
    expect(ids(lane!.cells.backlog)).toEqual(["a"]);
  });

  it("keeps matching children when filtering, and all of them when the epic matches", () => {
    const tasks = [
      epic("e", { title: "Checkout" }),
      child("a", "e", { title: "Address" }),
      child("b", "e", { title: "Payment" }),
    ];
    const [byChild] = buildLanes(board(tasks), { ...noFilters, search: "pay" });
    expect(ids(byChild!.bands[0]!.cells.backlog)).toEqual(["b"]);
    const [byEpic] = buildLanes(board(tasks), { ...noFilters, search: "checkout" });
    expect(ids(byEpic!.bands[0]!.cells.backlog).sort()).toEqual(["a", "b"]);
    expect(buildLanes(board(tasks), { ...noFilters, search: "nothing" })).toEqual([]);
  });

  it("filters to one epic with ?epic=, ignoring unknown ids", () => {
    const tasks = [epic("e"), epic("f"), child("a", "e"), child("b", "f"), task("loose")];
    const lanes = buildLanes(board(tasks), { ...noFilters, epicId: "e" });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.bands.map((b) => b.id)).toEqual(["e"]);
    expect(ids(lanes[0]!.cells.backlog)).toEqual([]);
    expect(buildLanes(board(tasks), { ...noFilters, epicId: "nope", projectId: "p" })[0]!.bands).toHaveLength(2);
  });

  it("indexes rows and counts band cards in their columns, but not epics as open tasks", () => {
    const tasks = [epic("e"), child("a", "e"), task("loose")];
    const lanes = buildLanes(board(tasks), { ...noFilters, projectId: "p" });
    expect(rowIndex(lanes)).toEqual(
      new Map([
        ["a", "e"],
        ["loose", "p"],
      ]),
    );
    expect(findRow(lanes, "e")?.projectId).toBe("p");
    expect(columnCounts(lanes).backlog).toBe(2);
    expect(openTaskCounts(tasks).get("p")).toBe(2);
  });

  it("reuses an unchanged band across rebuilds", () => {
    const snapshot = board([epic("e"), child("a", "e"), task("loose")]);
    const first = buildLanes(snapshot, noFilters);
    const changed = { ...snapshot, tasks: [...snapshot.tasks.slice(0, 2), task("loose", { title: "renamed" })] };
    const second = reuseUnchangedLanes(first, buildLanes(changed, noFilters));
    expect(second[0]!.bands[0]).toBe(first[0]!.bands[0]);
    expect(second[0]!.cells).not.toBe(first[0]!.cells);
  });
});
