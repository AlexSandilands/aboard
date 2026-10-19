import type { BoardSnapshot, Project, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  attentionTasks,
  buildLanes,
  columnCounts,
  COLUMN_PREVIEW_COUNT,
  findRow,
  isInPriorityLane,
  laneHasCollapsibleCell,
  matchesTaskSearch,
  openTaskCounts,
  PRIORITY_ROW_ID,
  reuseUnchangedLanes,
  rowIndex,
  visibleCellTasks,
} from "./board.logic";
import type { TaskOwnFilters } from "./boardFilters.logic";

function project(id: string): Project {
  return {
    id,
    title: id,
    workspaceRoot: null,
    workspaceKey: null,
    icon: null,
    t3ProjectId: null,
    reviewSkill: null,
    planSkill: null,
    variables: [],
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
    attentionRequest: null,
    lastNote: null,
    autoReview: null,
    autopilot: null,
    autoMerge: null,
    priority: false,
    manual: false,
    dueDate: null,
    delivery: null,
    integrationBranch: null,
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
    autopilot: { paused: false, active: [] },
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

  describe("a finished epic", () => {
    const doneEpic = (id: string, statusChangedAt: string, overrides: Partial<TaskSummary> = {}) =>
      epic(id, { status: "done", statusChangedAt, ...overrides });
    const doneChild = (id: string, epicId: string, overrides: Partial<TaskSummary> = {}) =>
      child(id, epicId, { status: "done", ...overrides });

    it("is one card in Done instead of a band, ordered with the other Done cards by when it finished", () => {
      const [lane] = buildLanes(
        board([
          doneEpic("e", "2026-02-01"),
          doneChild("a", "e"),
          doneChild("b", "e"),
          task("older", { status: "done", statusChangedAt: "2026-01-01" }),
          task("newer", { status: "done", statusChangedAt: "2026-03-01" }),
          epic("open"),
          child("c", "open", { status: "planned" }),
        ]),
        { ...noFilters, projectId: "p" },
      );
      expect(lane!.bands.map((b) => b.id)).toEqual(["open"]);
      expect(ids(lane!.cells.done)).toEqual(["newer", "e", "older"]);
    });

    it("groups its tasks under the card and doesn't repeat them loose", () => {
      const [lane] = buildLanes(board([doneEpic("e", "2026-02-01"), doneChild("a", "e"), doneChild("b", "e")]), {
        ...noFilters,
        projectId: "p",
      });
      expect(Object.keys(lane!.epicChildren)).toEqual(["e"]);
      expect(ids(lane!.epicChildren.e!).sort()).toEqual(["a", "b"]);
      expect(ids(lane!.cells.done)).toEqual(["e"]);
      expect(columnCounts([lane!]).done).toBe(1);
      expect(rowIndex([lane!]).has("a")).toBe(false);
    });

    it("brings the band back when a task leaves Done", () => {
      const tasks = [doneEpic("e", "2026-02-01"), doneChild("a", "e"), doneChild("b", "e")];
      const reopened = tasks.map((t) => (t.id === "b" ? { ...t, status: "review" as const } : t));
      reopened[0] = { ...reopened[0]!, status: "review" };
      const [lane] = buildLanes(board(reopened), { ...noFilters, projectId: "p" });
      expect(lane!.bands.map((b) => [b.id, b.start, b.end])).toEqual([["e", 3, 4]]);
      expect(ids(lane!.cells.done)).toEqual([]);
      expect(lane!.epicChildren).toEqual({});
    });

    it("keeps the card when a search matches only a task inside it, with just the matching tasks", () => {
      const tasks = [
        doneEpic("e", "2026-02-01", { title: "Checkout" }),
        doneChild("a", "e", { title: "Address" }),
        doneChild("b", "e", { title: "Payment" }),
      ];
      const [byChild] = buildLanes(board(tasks), { ...noFilters, search: "pay" });
      expect(ids(byChild!.cells.done)).toEqual(["e"]);
      expect(ids(byChild!.epicChildren.e!)).toEqual(["b"]);
      const [byEpic] = buildLanes(board(tasks), { ...noFilters, search: "checkout" });
      expect(ids(byEpic!.epicChildren.e!).sort()).toEqual(["a", "b"]);
      expect(buildLanes(board(tasks), { ...noFilters, search: "nothing" })).toEqual([]);
    });

    it("lists archived tasks of the epic in the card when they are shown", () => {
      const archived = doneChild("old", "e", { archivedAt: "2026-01-01" });
      const [lane] = buildLanes(board([doneEpic("e", "2026-02-01"), doneChild("a", "e")]), noFilters, [archived]);
      expect(ids(lane!.epicChildren.e!).sort()).toEqual(["a", "old"]);
      expect(ids(lane!.cells.done)).toEqual(["e"]);
    });

    it("keeps its band when filtered to with ?epic=", () => {
      const tasks = [doneEpic("e", "2026-02-01"), doneChild("a", "e")];
      const [lane] = buildLanes(board(tasks), { ...noFilters, epicId: "e" });
      expect(lane!.bands.map((b) => b.id)).toEqual(["e"]);
      expect(ids(lane!.cells.done)).toEqual([]);
    });

    it("reuses the card's tasks across rebuilds until one of them changes", () => {
      const snapshot = board([doneEpic("e", "2026-02-01"), doneChild("a", "e"), task("loose")]);
      const first = buildLanes(snapshot, noFilters);
      const same = reuseUnchangedLanes(first, buildLanes({ ...snapshot, tasks: [...snapshot.tasks] }, noFilters));
      expect(same[0]).toBe(first[0]);
      const renamed = { ...snapshot, tasks: snapshot.tasks.map((t) => (t.id === "a" ? { ...t, title: "x" } : t)) };
      const next = reuseUnchangedLanes(first, buildLanes(renamed, noFilters));
      expect(next[0]!.epicChildren.e).not.toBe(first[0]!.epicChildren.e);
      expect(next[0]!.cells).toBe(first[0]!.cells);
    });
  });
});

describe("buildLanes: the priority lane", () => {
  const withLane = { ...noFilters, priorityLane: true };
  const tasks = [
    task("a", { projectId: "p", priority: true, status: "planned" }),
    task("b", { projectId: "q", priority: true, status: "planned", position: "a0" }),
    task("c", { projectId: "p", status: "planned" }),
    task("d", { projectId: "p", priority: true, status: "backlog", archivedAt: "2026-01-01T00:00:00.000Z" }),
  ];

  it("gathers priority tasks from every project in a lane before the projects, which no longer hold them", () => {
    const lanes = buildLanes(board(tasks), withLane);
    expect(lanes.map((l) => l.project.id)).toEqual([PRIORITY_ROW_ID, "p", "q"]);
    expect(lanes[0]!.priority).toBe(true);
    expect(lanes[0]!.cells.planned.map((t) => t.id)).toEqual(["a", "b"]);
    expect(lanes[1]!.cells.planned.map((t) => t.id)).toEqual(["c"]);
    expect(lanes[2]!.cells.planned).toEqual([]);
    expect(rowIndex(lanes).get("b")).toBe(PRIORITY_ROW_ID);
  });

  it("leaves priority tasks in their projects when the lane is off, and builds no empty lane", () => {
    expect(buildLanes(board(tasks), noFilters).map((l) => l.project.id)).toEqual(["p", "q"]);
    const none = buildLanes(board([task("c")]), withLane);
    expect(none.some((l) => l.priority)).toBe(false);
  });

  it("leaves a Done priority task in its project, and brings it back to the lane when reopened", () => {
    const done = task("f", { projectId: "p", priority: true, status: "done" });
    const lanes = buildLanes(board([done]), withLane);
    expect(lanes.map((l) => l.project.id)).toEqual(["p", "q"]);
    expect(lanes[0]!.cells.done.map((t) => t.id)).toEqual(["f"]);
    const reopened = buildLanes(board([{ ...done, status: "planned" }]), withLane);
    expect(reopened[0]!.priority).toBe(true);
  });

  it("keeps archived priority tasks in their project", () => {
    const lanes = buildLanes(board(tasks), withLane, [tasks[3]!]);
    expect(lanes[0]!.cells.backlog).toEqual([]);
    expect(lanes[1]!.cells.backlog.map((t) => t.id)).toEqual(["d"]);
  });

  it("shows whatever project is scoped to, and still applies the card filters", () => {
    expect(buildLanes(board(tasks), { ...withLane, projectId: "q" }).map((l) => l.project.id)).toEqual([
      PRIORITY_ROW_ID,
      "q",
    ]);
    const filtered = buildLanes(board(tasks), { ...withLane, search: "zzz" });
    expect(filtered).toEqual([]);
    const search = buildLanes(board(tasks), { ...withLane, search: "b" });
    expect(search.map((l) => l.project.id)).toEqual([PRIORITY_ROW_ID]);
    expect(search[0]!.cells.planned.map((t) => t.id)).toEqual(["b"]);
  });

  it("is kept through reuseUnchangedLanes", () => {
    const first = buildLanes(board(tasks), withLane);
    const next = reuseUnchangedLanes(first, buildLanes(board(tasks), withLane));
    expect(next[0]).toBe(first[0]);
    const changed = reuseUnchangedLanes(first, buildLanes(board([...tasks, task("e", { priority: true })]), withLane));
    expect(changed[0]!.priority).toBe(true);
  });
});

describe("isInPriorityLane", () => {
  it("holds open priority tasks only", () => {
    expect(isInPriorityLane(task("a", { priority: true, status: "review" }))).toBe(true);
    expect(isInPriorityLane(task("a", { status: "review" }))).toBe(false);
    expect(isInPriorityLane(task("a", { priority: true, status: "done" }))).toBe(false);
    expect(isInPriorityLane(task("a", { priority: true, archivedAt: "2026-01-01T00:00:00.000Z" }))).toBe(false);
    expect(isInPriorityLane(task("a", { priority: true, kind: "epic" }))).toBe(false);
  });
});

describe("buildLanes: in progress only", () => {
  it("shows only In Progress cards, from every project", () => {
    const lanes = buildLanes(
      board([
        task("a", { projectId: "p", status: "in_progress" }),
        task("b", { projectId: "q", status: "in_progress" }),
        task("c", { projectId: "p", status: "planned" }),
      ]),
      { ...noFilters, inProgressOnly: true },
    );
    expect(lanes.map((l) => l.project.id)).toEqual(["p", "q"]);
    expect(lanes.flatMap((l) => STATUS_ALL.flatMap((s) => l.cells[s].map((t) => t.id)))).toEqual(["a", "b"]);
  });

  it("holds back a task whose epic is in progress", () => {
    const epic = task("e", { kind: "epic", status: "in_progress" });
    const lanes = buildLanes(
      board([
        epic,
        task("a", { status: "in_progress", parent: { id: "e", number: 1, title: "e" } }),
        task("b", { status: "planned", parent: { id: "e", number: 1, title: "e" } }),
      ]),
      { ...noFilters, inProgressOnly: true },
    );
    expect(lanes[0]!.bands[0]!.cells.planned).toEqual([]);
    expect(lanes[0]!.bands[0]!.cells.in_progress.map((t) => t.id)).toEqual(["a"]);
  });
});

describe("buildLanes: task filters", () => {
  const ids = (lanes: ReturnType<typeof buildLanes>) =>
    lanes.flatMap((l) => STATUS_ALL.flatMap((s) => l.cells[s].map((t) => t.id)));
  const own: TaskOwnFilters = { statuses: [], tiers: [], autopilot: [], blocked: false, priority: false };

  it("filters by status, tier, Autopilot flag and blocked", () => {
    const tasks = [
      task("a", { status: "review", blocked: true, autopilot: true, suggestedModel: { tier: "deep", reason: null } }),
      task("b", { status: "review" }),
      task("c", { status: "planned", blocked: true }),
    ];
    const run = (taskFilters: Partial<TaskOwnFilters>) =>
      ids(buildLanes(board(tasks), { ...noFilters, taskFilters: { ...own, ...taskFilters } }));
    expect(run({ statuses: ["review"] })).toEqual(["a", "b"]);
    expect(run({ blocked: true })).toEqual(["c", "a"]);
    expect(run({ tiers: ["deep"] })).toEqual(["a"]);
    expect(run({ tiers: ["none"] })).toEqual(["c", "b"]);
    expect(run({ autopilot: ["on"] })).toEqual(["a"]);
    expect(run({ statuses: ["review"], blocked: true })).toEqual(["a"]);
  });

  it("drops lanes with no match", () => {
    const lanes = buildLanes(board([task("a", { projectId: "p", status: "review" }), task("b", { projectId: "q" })]), {
      ...noFilters,
      taskFilters: { ...own, statuses: ["review"] },
    });
    expect(lanes.map((l) => l.project.id)).toEqual(["p"]);
  });

  it("filters to priority tasks, which stay in the priority lane", () => {
    const lanes = buildLanes(board([task("a", { priority: true, status: "planned" }), task("b")]), {
      ...noFilters,
      priorityLane: true,
      taskFilters: { ...own, priority: true },
    });
    expect(lanes.map((l) => l.project.id)).toEqual([PRIORITY_ROW_ID]);
    expect(ids(lanes)).toEqual(["a"]);
  });

  it("leaves no empty band for tier, Autopilot, blocked or priority filters, which describe tasks, not epics", () => {
    const epic = task("e", { kind: "epic" });
    const deep = { tier: "deep", reason: null } as const;
    const child = task("a", { parent: { id: "e", number: 1, title: "e" }, suggestedModel: deep, autopilot: true });
    const lanes = (taskFilters: Partial<TaskOwnFilters>) =>
      buildLanes(board([epic, child]), { ...noFilters, taskFilters: { ...own, ...taskFilters } });
    expect(lanes({ tiers: ["none"] })).toEqual([]);
    expect(lanes({ autopilot: ["default"] })).toEqual([]);
    expect(lanes({ blocked: true })).toEqual([]);
    expect(lanes({ tiers: ["deep"] })[0]!.bands.map((b) => b.id)).toEqual(["e"]);
  });

  it("holds an epic's children to the filter, and drops an epic left with none", () => {
    const epic = task("e", { kind: "epic", status: "in_progress" });
    const empty = task("e2", { kind: "epic" });
    const child = (id: string, status: TaskSummary["status"]) =>
      task(id, { status, parent: { id: "e", number: 1, title: "e" } });
    const lanes = buildLanes(board([epic, empty, child("a", "review"), child("b", "planned")]), {
      ...noFilters,
      taskFilters: { ...own, statuses: ["review"] },
    });
    expect(lanes[0]!.bands.map((b) => b.id)).toEqual(["e"]);
    expect(lanes[0]!.bands[0]!.cells.review.map((t) => t.id)).toEqual(["a"]);
    expect(lanes[0]!.bands[0]!.cells.planned).toEqual([]);
  });
});

const STATUS_ALL = ["backlog", "planned", "in_progress", "review", "done"] as const;
