import type { BoardSnapshot, Project, TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { attentionTasks, buildLanes, matchesTaskSearch, reuseUnchangedLanes } from "./board.logic";

function project(id: string): Project {
  return {
    id,
    title: id,
    workspaceRoot: null,
    workspaceKey: null,
    icon: null,
    t3ProjectId: null,
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
    title: id,
    status: "idea",
    position: "a0",
    archivedAt: null,
    createdBy: "user",
    createdAt: "",
    updatedAt: "",
    statusChangedAt: "",
    resolution: null,
    resolvedBy: null,
    progress: { done: 0, total: 0 },
    stepStatuses: [],
    currentStep: null,
    links: [],
    attention: [],
    lastNote: null,
    ...overrides,
  };
}

function board(tasks: TaskSummary[], projects = [project("p"), project("q")]): BoardSnapshot {
  return {
    projects,
    tasks,
    integrations: {
      t3: { detected: false, origin: null, environmentId: null, label: null, liveStatus: "off", error: null },
    },
  };
}

const noFilters = { projectId: null, search: "", attentionOnly: false, hasPrOnly: false };

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
    expect(lanes[0]!.cells.idea.map((t) => t.id)).toEqual(["a", "b"]);
    expect(lanes[0]!.cells.done.map((t) => t.id)).toEqual(["new", "old"]);
    expect(lanes[1]!.cells.idea.map((t) => t.id)).toEqual(["other"]);
  });

  it("scopes to a project and keeps empty lanes unless filtering", () => {
    expect(buildLanes(board([]), { ...noFilters, projectId: "q" }).map((l) => l.project.id)).toEqual(["q"]);
    expect(buildLanes(board([]), { ...noFilters, projectId: "missing" })).toHaveLength(2);
    expect(buildLanes(board([task("x")]), { ...noFilters, search: "x" }).map((l) => l.project.id)).toEqual(["p"]);
  });

  it("filters to tasks needing attention", () => {
    const flagged = task("flagged", { attention: [{ kind: "blocked_step", severity: "warning", message: "Blocked" }] });
    const lanes = buildLanes(board([flagged, task("calm")]), { ...noFilters, attentionOnly: true });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.cells.idea).toEqual([flagged]);
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
    expect(lanes[0]!.cells.idea).toEqual([withPr]);
  });

  it("merges archived tasks into their lanes, preferring the snapshot copy", () => {
    const live = task("live");
    const archived = task("old", { archivedAt: "2026-01-01", position: "a1" });
    const stale = { ...live, archivedAt: "2026-01-01" };
    const lanes = buildLanes(board([live]), noFilters, [archived, stale]);
    expect(lanes[0]!.cells.idea).toEqual([live, archived]);
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
    expect(second[1]!.cells.idea).toEqual([changedB]);
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
