import { describe, expect, it } from "vitest";
import {
  classifyLink,
  deriveAttention,
  deriveCurrentStep,
  deriveProgress,
  deriveProjectIdentity,
  normalizeWorkspaceKey,
  parsePlanMarkdown,
  type PlanPhase,
  type StepStatus,
} from "./index.ts";

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

describe("deriveProgress", () => {
  it("counts done and skipped as complete", () => {
    expect(deriveProgress(phases(["done", "skipped", "todo"], ["blocked"]))).toEqual({ done: 2, total: 4 });
  });
});

describe("deriveAttention", () => {
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

describe("classifyLink", () => {
  it("recognizes PRs, Jira and T3 threads", () => {
    expect(classifyLink("https://github.com/acme/app/pull/42")).toMatchObject({
      kind: "pr",
      ref: { host: "github.com", repo: "acme/app", number: 42 },
    });
    expect(classifyLink("https://dev.azure.com/org/proj/_git/repo/pullrequest/7")).toMatchObject({ kind: "pr", ref: null });
    expect(classifyLink("ABC-123", { jiraBaseUrl: "https://jira.example.com/" })).toEqual({
      kind: "jira",
      key: "ABC-123",
      url: "https://jira.example.com/browse/ABC-123",
    });
    expect(classifyLink("t3code://threads/env-1/thread%3A2")).toMatchObject({
      kind: "t3_thread",
      ref: { environmentId: "env-1", threadId: "thread:2" },
    });
    expect(classifyLink("https://example.com")).toEqual({ kind: "url", url: "https://example.com" });
    expect(classifyLink("not a link")).toBeNull();
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
