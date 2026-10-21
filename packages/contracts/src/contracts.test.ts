import { describe, expect, it } from "vitest";
import {
  classifyLink,
  deliveryHintApplies,
  formatProjectScope,
  parseProjectScope,
  epicBranchName,
  startedEpicTasks,
  deriveAttention,
  describeEpicRollup,
  deriveEpicStatus,
  epicBranchMerge,
  type PrSnapshot,
  type TaskLink,
  deriveCurrentStep,
  deriveProgress,
  deriveProjectIdentity,
  dueState,
  DueDate,
  normalizeWorkspaceKey,
  parseImportSource,
  parsePlanMarkdown,
  PROJECT_ICON_IMAGE_MAX_LENGTH,
  ProjectIcon,
  T3ThreadSnapshot,
  TaskStatus,
  TaskStatusInput,
  TICKET_SYSTEM_PRESETS,
  type PlanPhase,
  type StepStatus,
} from "./index.ts";

const jira = { ...TICKET_SYSTEM_PRESETS[0]!.system, linkTemplate: "https://jira.example.com/browse/{key}" };
const linear = TICKET_SYSTEM_PRESETS[1]!.system;

function phases(...defs: StepStatus[][]): PlanPhase[] {
  return defs.map((steps, pi) => ({
    id: `p${pi}`,
    title: `Phase ${pi + 1}`,
    position: String(pi),
    steps: steps.map((status, si) => ({
      id: `s${pi}.${si}`,
      phaseId: `p${pi}`,
      title: `Step ${pi + 1}.${si + 1}`,
      notes: null,
      status,
      position: String(si),
      startedAt: null,
      completedAt: null,
      updatedAt: "",
    })),
  }));
}

describe("deriveCurrentStep", () => {
  it("prefers the in-progress step", () => {
    expect(deriveCurrentStep(phases(["done", "todo"], ["in_progress"]))?.index).toBe("2.1");
  });
  it("falls back to blocked, then the first todo after the last completed step", () => {
    expect(deriveCurrentStep(phases(["done", "blocked", "todo"]))?.index).toBe("1.2");
    expect(deriveCurrentStep(phases(["todo", "done"], ["todo"]))?.index).toBe("2.1");
    expect(deriveCurrentStep(phases(["done", "skipped"], ["todo", "todo"]))?.id).toBe("s1.0");
  });
  it("returns null for an empty or fully complete plan", () => {
    expect(deriveCurrentStep([])).toBeNull();
    expect(deriveCurrentStep(phases(["done", "skipped"]))).toBeNull();
  });
});

describe("dueState", () => {
  it("compares calendar dates, across month and year edges", () => {
    expect(dueState("2026-11-01", "2026-11-02")).toBe("overdue");
    expect(dueState("2026-11-02", "2026-11-02")).toBe("today");
    expect(dueState("2026-11-03", "2026-11-02")).toBe("later");
    expect(dueState("2026-12-31", "2027-01-01")).toBe("overdue");
    expect(dueState("2027-01-01", "2026-12-31")).toBe("later");
    expect(dueState("2026-02-28", "2026-03-01")).toBe("overdue");
  });
});

describe("DueDate", () => {
  it("accepts real calendar dates only", () => {
    expect(DueDate.safeParse("2028-02-29").success).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "11/02/2026", "2026-11-02T00:00:00Z", ""]) {
      expect(DueDate.safeParse(bad).success).toBe(false);
    }
  });
});

describe("deriveProgress", () => {
  it("counts done and skipped as complete", () => {
    expect(deriveProgress(phases(["done", "skipped", "todo"], ["blocked"]))).toEqual({ done: 2, total: 4 });
  });
});

describe("deriveAttention", () => {
  it("warns about a failed import, with the reason", () => {
    const failed = { status: "failed", error: "gh isn't signed in", sourceUrl: "PROJ-1" } as const;
    expect(deriveAttention([], [], null, failed)).toEqual([
      { kind: "import_failed", severity: "warning", message: "Import failed: gh isn't signed in" },
    ]);
    expect(deriveAttention([], [], null, { ...failed, status: "pending", error: null })).toEqual([]);
  });

  it("flags blocked steps and failing PRs", () => {
    const reasons = deriveAttention(phases(["blocked"]), [
      {
        id: "l",
        taskId: "t",
        kind: "pr",
        url: "https://github.com/a/b/pull/1",
        label: null,
        syncedAt: null,
        createdAt: "",
        ref: { host: "github.com", repo: "a/b", number: 1 },
        snapshot: {
          state: "open",
          title: "x",
          checks: "failing",
          reviewDecision: "changes_requested",
          mergeable: "conflicting",
          headRef: null,
          updatedAt: null,
        },
      },
    ]);
    expect(reasons.map((r) => r.kind)).toEqual([
      "blocked_step",
      "pr_checks_failing",
      "pr_changes_requested",
      "pr_conflict",
    ]);
  });
});

describe("T3ThreadSnapshot", () => {
  it("parses snapshots stored before the detail fields existed", () => {
    expect(T3ThreadSnapshot.parse({ title: "x", status: "done" })).toEqual({ title: "x", status: "done" });
  });
});

describe("normalizeWorkspaceKey", () => {
  it("normalizes Windows paths case-insensitively", () => {
    expect(normalizeWorkspaceKey("C:\\Code\\T3Code\\")).toBe("c:/code/t3code");
    expect(normalizeWorkspaceKey("c:/code/t3code")).toBe("c:/code/t3code");
  });
  it("keeps POSIX case and strips trailing slashes", () => {
    expect(normalizeWorkspaceKey("/home/Me/proj//")).toBe("/home/Me/proj");
    expect(normalizeWorkspaceKey("/")).toBe("/");
  });
});

describe("deriveProjectIdentity", () => {
  it("builds monograms like T3 Code", () => {
    expect(deriveProjectIdentity("t3code").monogram).toBe("T3");
    expect(deriveProjectIdentity("shop tools").monogram).toBe("ST");
    expect(deriveProjectIdentity("storefront").monogram).toBe("ST");
    expect(deriveProjectIdentity("").monogram).toBe("PR");
  });
  it("is stable", () => {
    expect(deriveProjectIdentity("storefront").color).toBe(deriveProjectIdentity("Storefront").color);
  });
});

describe("ProjectIcon image", () => {
  const ok = (dataUrl: string) => ProjectIcon.safeParse({ kind: "image", dataUrl }).success;

  it("accepts raster base64 data URLs", () => {
    for (const type of ["png", "jpeg", "webp", "gif"]) expect(ok(`data:image/${type};base64,iVBORw0KGgo=`)).toBe(true);
  });

  it("rejects SVG, remote URLs, non-base64 payloads and oversized values", () => {
    expect(ok("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(ok("https://example.com/icon.png")).toBe(false);
    expect(ok("data:image/png,<svg onload=alert(1)>")).toBe(false);
    expect(ok(`data:image/png;base64,${"A".repeat(PROJECT_ICON_IMAGE_MAX_LENGTH)}`)).toBe(false);
  });
});

describe("classifyLink", () => {
  it("recognizes PRs, tickets and T3 threads", () => {
    expect(classifyLink("https://github.com/acme/app/pull/42")).toMatchObject({
      kind: "pr",
      ref: { host: "github.com", repo: "acme/app", number: 42 },
    });
    expect(classifyLink("https://dev.azure.com/org/proj/_git/repo/pullrequest/7")).toMatchObject({
      kind: "pr",
      ref: null,
    });
    expect(classifyLink("ABC-123", { ticketSystems: [jira] })).toEqual({
      kind: "ticket",
      ref: { system: "jira", key: "ABC-123" },
      url: "ABC-123",
    });
    expect(classifyLink("t3code://threads/env-1/thread%3A2")).toMatchObject({
      kind: "t3_thread",
      ref: { environmentId: "env-1", threadId: "thread:2" },
    });
    expect(classifyLink("https://example.com")).toEqual({ kind: "url", url: "https://example.com" });
    expect(classifyLink("not a link")).toBeNull();
  });

  describe("with a detected T3", () => {
    const t3 = { environmentId: "env-1", origin: "http://127.0.0.1:3773" };
    const uuid = "bca46358-2812-4417-93f7-e151c0f96292";

    it("turns a bare thread id into a thread link in the detected environment", () => {
      expect(classifyLink(uuid, { t3 })).toEqual({
        kind: "t3_thread",
        url: `t3code://threads/env-1/${uuid}`,
        ref: { environmentId: "env-1", threadId: uuid },
      });
      expect(classifyLink(` ${uuid.toUpperCase()} `, { t3 })).toMatchObject({
        kind: "t3_thread",
        ref: { threadId: uuid },
      });
      expect(classifyLink("thread:project:p1:t1", { t3 })).toMatchObject({
        kind: "t3_thread",
        ref: { environmentId: "env-1", threadId: "thread:project:p1:t1" },
      });
    });

    it("leaves a bare id unrecognised without a detected T3, or with a half-detected one", () => {
      expect(classifyLink(uuid)).toBeNull();
      expect(classifyLink(uuid, { t3: null })).toBeNull();
      expect(classifyLink(uuid, { t3: { environmentId: null, origin: null } })).toBeNull();
    });

    it("does not take other text for a thread id", () => {
      expect(classifyLink("thread:", { t3 })).toBeNull();
      expect(classifyLink(`${uuid} extra`, { t3 })).toBeNull();
      expect(classifyLink("bca46358", { t3 })).toBeNull();
    });

    it("recognises browser URLs of the detected T3 only", () => {
      expect(classifyLink(`http://127.0.0.1:3773/env-1/${uuid}`, { t3 })).toMatchObject({
        kind: "t3_thread",
        ref: { environmentId: "env-1", threadId: uuid },
      });
      expect(classifyLink(`http://127.0.0.1:3773/env-1/${uuid}/?x=1#y`, { t3 })).toMatchObject({ kind: "t3_thread" });
      // Another origin, another environment, or a different page of the T3 app stays a plain URL.
      for (const url of [
        `http://127.0.0.1:9999/env-1/${uuid}`,
        `http://127.0.0.1:3773/env-2/${uuid}`,
        "http://127.0.0.1:3773/settings",
        `http://127.0.0.1:3773/env-1/${uuid}/diff`,
      ]) {
        expect(classifyLink(url, { t3 })).toEqual({ kind: "url", url });
      }
    });
  });

  it("treats /owner/repo/pull/n on any host as a GitHub-style PR", () => {
    expect(classifyLink("https://github.com/acme/app/pull/42/files?w=1")).toMatchObject({
      kind: "pr",
      ref: { host: "github.com", repo: "acme/app", number: 42 },
    });
    expect(classifyLink("https://GHE.Example.com/team/svc/pull/7")).toMatchObject({
      kind: "pr",
      ref: { host: "ghe.example.com", repo: "team/svc", number: 7 },
    });
    expect(classifyLink("https://example.ghe.com/team/svc/pull/8#discussion")).toMatchObject({
      kind: "pr",
      ref: { host: "example.ghe.com", repo: "team/svc", number: 8 },
    });
    expect(classifyLink("https://bitbucket.org/team/repo/pull-requests/3")).toMatchObject({ kind: "pr", ref: null });
    expect(classifyLink("https://org.visualstudio.com/proj/_git/repo/pullrequest/9")).toMatchObject({
      kind: "pr",
      ref: null,
    });
    expect(classifyLink("https://github.com/acme/app/pull/42abc")).toMatchObject({ kind: "url" });
    expect(classifyLink("https://github.com/acme/app/issues/42")).toMatchObject({
      kind: "issue",
      ref: { host: "github.com", repo: "acme/app", number: 42 },
    });
    expect(classifyLink("https://github.com/acme/pull/42")).toMatchObject({ kind: "url" });
  });
});

describe("parseImportSource", () => {
  const { linkTemplate: _template, ...unlinked } = jira;
  const ticketSystems = [unlinked];

  it("reads a configured system's bare key and URL", () => {
    expect(parseImportSource("PROJ-123", ticketSystems)).toEqual({
      kind: "ticket",
      ref: { system: "jira", key: "PROJ-123" },
      url: "PROJ-123",
      placeholder: "PROJ-123",
    });
    expect(parseImportSource("  PROJ-123 ", [jira])).toMatchObject({
      kind: "ticket",
      url: "PROJ-123",
    });
    expect(parseImportSource("https://jira.example.com/browse/ABC-7?focusedId=1", ticketSystems)).toEqual({
      kind: "ticket",
      ref: { system: "jira", key: "ABC-7" },
      url: "https://jira.example.com/browse/ABC-7?focusedId=1",
      placeholder: "ABC-7",
    });
  });

  it("knows no tickets without configured systems", () => {
    expect(parseImportSource("PROJ-123")).toBeNull();
    expect(parseImportSource("https://jira.example.com/browse/ABC-7")).toBeNull();
  });

  it("reads a GitHub issue URL on any host", () => {
    expect(parseImportSource("https://github.com/acme/app/issues/45")).toEqual({
      kind: "issue",
      ref: { host: "github.com", repo: "acme/app", number: 45 },
      url: "https://github.com/acme/app/issues/45",
      placeholder: "acme/app#45",
    });
    expect(parseImportSource("https://ghe.example.com/team/svc/issues/8#issuecomment-1")).toMatchObject({
      kind: "issue",
      ref: { host: "ghe.example.com", repo: "team/svc", number: 8 },
    });
  });

  it("is null for anything else", () => {
    expect(parseImportSource("https://github.com/acme/app/pull/45", ticketSystems)).toBeNull();
    expect(parseImportSource("https://github.com/acme/app/issues", ticketSystems)).toBeNull();
    expect(parseImportSource("https://example.com/browse", ticketSystems)).toBeNull();
    expect(parseImportSource("Fix PROJ-123 login", ticketSystems)).toBeNull();
    expect(parseImportSource("proj-123", ticketSystems)).toBeNull();
    expect(parseImportSource("UTF-8", ticketSystems)).toBeNull();
    expect(parseImportSource("", ticketSystems)).toBeNull();
  });

  it("gives a key two systems match to the first, and a URL to the system it belongs to", () => {
    expect(parseImportSource("ENG-4", [linear, jira])).toMatchObject({
      ref: { system: "linear", key: "ENG-4" },
    });
    expect(parseImportSource("https://linear.app/acme/issue/ENG-4/fix-it", [jira, linear])).toMatchObject({
      ref: { system: "linear", key: "ENG-4" },
    });
  });
});

describe("parsePlanMarkdown", () => {
  it("turns headings into phases and list items into steps", () => {
    const plan = parsePlanMarkdown(`# My plan

Some context here.

## Backend
- [x] Add migration
- [ ] Write service
  needs care with ordering
## Frontend
1. Build card
2. [~] Build panel
`);
    expect(plan).toEqual({
      context: "Some context here.",
      phases: [
        {
          title: "Backend",
          steps: [
            { title: "Add migration", status: "done" },
            { title: "Write service", status: "todo", notes: "needs care with ordering" },
          ],
        },
        {
          title: "Frontend",
          steps: [
            { title: "Build card", status: "todo" },
            { title: "Build panel", status: "in_progress" },
          ],
        },
      ],
    });
  });

  it("uses a single Plan phase without headings and nests sub-items as notes", () => {
    const plan = parsePlanMarkdown("- one\n  - detail a\n- two\n");
    expect(plan?.phases).toEqual([
      {
        title: "Plan",
        steps: [
          { title: "one", status: "todo", notes: "- detail a" },
          { title: "two", status: "todo" },
        ],
      },
    ]);
  });

  it("returns null when there are no steps", () => {
    expect(parsePlanMarkdown("just prose")).toBeNull();
  });
});

describe("TaskStatusInput", () => {
  it("reads the old idea status as backlog", () => {
    expect(TaskStatusInput.parse("idea")).toBe("backlog");
    expect(TaskStatusInput.parse("planned")).toBe("planned");
    expect(TaskStatus.safeParse("idea").success).toBe(false);
  });
});

describe("describeEpicRollup", () => {
  it("says how many are done and where the rest are", () => {
    const byStatus = { backlog: 1, planned: 0, in_progress: 2, review: 0, done: 2 };
    expect(describeEpicRollup({ total: 5, done: 2, byStatus })).toBe("2/5 done · 2 In Progress, 1 Backlog");
    expect(
      describeEpicRollup({ total: 0, done: 0, byStatus: { ...byStatus, backlog: 0, in_progress: 0, done: 0 } }),
    ).toBe("No tasks yet");
  });
});

describe("deriveEpicStatus", () => {
  const rollup = (byStatus: Partial<Record<TaskStatus, number>>) => {
    const counts = { backlog: 0, planned: 0, in_progress: 0, review: 0, done: 0, ...byStatus };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { total, done: counts.done, byStatus: counts };
  };

  it("follows the furthest-back task, and is Backlog with none", () => {
    expect(deriveEpicStatus(rollup({}))).toBe("backlog");
    expect(deriveEpicStatus(rollup({ in_progress: 1, done: 2 }))).toBe("in_progress");
    expect(deriveEpicStatus(rollup({ review: 1, done: 2 }))).toBe("review");
    expect(deriveEpicStatus(rollup({ done: 3 }))).toBe("done");
  });

  it("holds a finished epic in Review while its branch is unmerged", () => {
    expect(deriveEpicStatus(rollup({ done: 3 }), true)).toBe("review");
    // Only the finished case changes: an epic with open tasks sits where they are, and an empty one in Backlog.
    expect(deriveEpicStatus(rollup({ in_progress: 1, done: 2 }), true)).toBe("in_progress");
    expect(deriveEpicStatus(rollup({}), true)).toBe("backlog");
  });
});

describe("epicBranchMerge", () => {
  const branch = "epic/7-checkout";
  const pr = (state: PrSnapshot["state"], headRef: string | null, number = 1): TaskLink => ({
    id: `pr-${number}`,
    taskId: "epic",
    kind: "pr",
    url: `https://github.com/o/r/pull/${number}`,
    label: null,
    syncedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ref: { host: "github.com", repo: "o/r", number },
    snapshot: { state, headRef } as PrSnapshot,
  });
  const epic = {
    kind: "epic" as const,
    delivery: "integration" as const,
    integrationBranch: branch,
    integrationMergedAt: null,
  };

  it("is null unless the epic uses integration delivery", () => {
    expect(epicBranchMerge({ ...epic, delivery: "main", integrationBranch: null }, [])).toBeNull();
    expect(epicBranchMerge({ ...epic, delivery: null, integrationBranch: null }, [])).toBeNull();
    expect(epicBranchMerge({ ...epic, kind: "task" }, [])).toBeNull();
  });

  it("waits until a PR from the branch has merged", () => {
    expect(epicBranchMerge(epic, [])).toEqual({ merged: false, by: null, pr: null });
    const open = epicBranchMerge(epic, [pr("draft", branch, 4)]);
    expect(open).toEqual({ merged: false, by: null, pr: { host: "github.com", repo: "o/r", number: 4 } });
    expect(epicBranchMerge(epic, [pr("merged", branch, 4)])).toEqual({ merged: true, by: "pr", pr: open!.pr });
  });

  it("ignores PRs from other branches, and a closed one that never merged", () => {
    expect(epicBranchMerge(epic, [pr("merged", "task/9", 2)])?.merged).toBe(false);
    expect(epicBranchMerge(epic, [pr("closed", branch, 3)])?.merged).toBe(false);
    expect(epicBranchMerge(epic, [pr("closed", branch, 3), pr("merged", branch, 5)])).toMatchObject({
      merged: true,
      pr: { number: 5 },
    });
  });

  it("counts a manual mark, keeping the PR it was waiting for", () => {
    expect(epicBranchMerge({ ...epic, integrationMergedAt: "2026-01-02T00:00:00.000Z" }, [])).toEqual({
      merged: true,
      by: "manual",
      pr: null,
    });
    expect(
      epicBranchMerge({ ...epic, integrationMergedAt: "2026-01-02T00:00:00.000Z" }, [pr("open", branch, 4)]),
    ).toMatchObject({ merged: true, by: "manual", pr: { number: 4 } });
  });
});

describe("epic delivery helpers", () => {
  it("names an epic's branch from its number and title", () => {
    expect(epicBranchName({ number: 12, title: "One-page checkout!" })).toBe("epic/12-one-page-checkout");
    expect(epicBranchName({ number: 3, title: "Café ✨" })).toBe("epic/3-cafe");
    expect(epicBranchName({ number: 5, title: "???" })).toBe("epic/5");
    expect(epicBranchName({ number: 6, title: "a".repeat(80) })).toBe(`epic/6-${"a".repeat(40)}`);
  });

  const child = (id: string, status: TaskStatus, over: Record<string, unknown> = {}) => ({
    id,
    number: Number(id),
    status,
    resolution: null,
    archivedAt: null,
    blockedBy: [] as Array<{ id: string; number: number; title: string; status: TaskStatus; archived: boolean }>,
    ...over,
  });
  const epic = { kind: "epic" as const, delivery: null, archivedAt: null, status: "planned" as const };

  it("asks about delivery for related or plentiful tasks, until a delivery is chosen", () => {
    const blocker = { id: "1", number: 1, title: "A", status: "planned" as const, archived: false };
    const related = [child("1", "planned"), child("2", "backlog", { blockedBy: [blocker] })];
    expect(deliveryHintApplies(epic, related)).toBe(true);
    expect(deliveryHintApplies(epic, [child("1", "planned"), child("2", "backlog")])).toBe(false);
    expect(
      deliveryHintApplies(
        epic,
        ["1", "2", "3"].map((id) => child(id, "planned")),
      ),
    ).toBe(true);
    expect(deliveryHintApplies({ ...epic, delivery: "main" }, related)).toBe(false);
    expect(deliveryHintApplies({ ...epic, status: "done" }, related)).toBe(false);
  });

  it("counts tasks past Planned as started, but not closed ones", () => {
    const started = startedEpicTasks([
      child("1", "planned"),
      child("2", "in_progress"),
      child("3", "done"),
      child("4", "done", { resolution: "wont_do" }),
      child("5", "review", { archivedAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(started.map((c) => c.id)).toEqual(["2", "3"]);
  });
});

describe("project scope", () => {
  const order = ["a", "b", "c"];

  it("reads a legacy single id as a list of one", () => {
    expect(parseProjectScope("b")).toEqual(["b"]);
    expect(parseProjectScope("b", order)).toEqual(["b"]);
  });

  it("drops blanks and repeats, and with the project list unknown ids and the order of the ids", () => {
    expect(parseProjectScope(" c, ,a,c")).toEqual(["c", "a"]);
    expect(parseProjectScope("c,gone,a", order)).toEqual(["a", "c"]);
    expect(parseProjectScope(undefined, order)).toEqual([]);
  });

  it("writes the ids in lane order and round-trips", () => {
    const value = formatProjectScope(["c", "a"], order);
    expect(value).toBe("a,c");
    expect(parseProjectScope(value, order)).toEqual(["a", "c"]);
  });

  it("is the whole board when nothing, or every project, is ticked", () => {
    expect(formatProjectScope([], order)).toBeUndefined();
    expect(formatProjectScope(["c", "b", "a"], order)).toBeUndefined();
    expect(formatProjectScope(["gone"], order)).toBeUndefined();
  });
});
