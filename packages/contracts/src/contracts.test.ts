import { describe, expect, it } from "vitest";
import {
  classifyLink,
  deriveAttention,
  describeEpicRollup,
  deriveCurrentStep,
  deriveProgress,
  deriveProjectIdentity,
  findJiraKeys,
  normalizeWorkspaceKey,
  parsePlanMarkdown,
  PROJECT_ICON_IMAGE_MAX_LENGTH,
  ProjectIcon,
  T3ThreadSnapshot,
  TaskStatus,
  TaskStatusInput,
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
  it("recognizes PRs, Jira and T3 threads", () => {
    expect(classifyLink("https://github.com/acme/app/pull/42")).toMatchObject({
      kind: "pr",
      ref: { host: "github.com", repo: "acme/app", number: 42 },
    });
    expect(classifyLink("https://dev.azure.com/org/proj/_git/repo/pullrequest/7")).toMatchObject({
      kind: "pr",
      ref: null,
    });
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
    expect(classifyLink("https://github.com/acme/pull/42")).toMatchObject({ kind: "url" });
  });
});

describe("findJiraKeys", () => {
  it("finds keys in titles and descriptions, in order, without duplicates", () => {
    expect(findJiraKeys("CORE-1245 Fix login")).toEqual(["CORE-1245"]);
    expect(findJiraKeys("Fix login (CORE-1245, OPS_2-7). See CORE-1245 and AB1-9.")).toEqual([
      "CORE-1245",
      "OPS_2-7",
      "AB1-9",
    ]);
    expect(findJiraKeys("Details: https://jira.example.com/browse/ABC-12?focus=1")).toEqual(["ABC-12"]);
    expect(findJiraKeys("ABC-1: done; DEF-2!")).toEqual(["ABC-1", "DEF-2"]);
    expect(findJiraKeys(null)).toEqual([]);
  });

  it("ignores lowercase, partial matches and common false positives", () => {
    expect(findJiraKeys("abc-123 and Abc-123")).toEqual([]);
    expect(findJiraKeys("foo_ABC-1 ABC-1x xABC-1 ABC-1-2 X-1")).toEqual([]);
    expect(findJiraKeys("UTF-8, SHA-256, ISO-8601, RFC-9110, CVE-2024-1234, X-Request-Id")).toEqual([]);
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
