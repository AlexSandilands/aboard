import type { PrSnapshot } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof AppError ? error.code : "NOT_APP_ERROR";
  }
  return undefined;
};

describe("projects", () => {
  it("resolves exact, nested and case-insensitive Windows paths", () => {
    const { services: s } = createTestHarness();
    const outer = s.projects.create({ workspaceRoot: "C:\\Code\\acme" });
    const inner = s.projects.create({ workspaceRoot: "C:\\Code\\acme\\apps\\web" });
    const unix = s.projects.create({ workspaceRoot: "/home/me/proj" });
    expect(outer.title).toBe("acme");
    expect(outer.workspaceKey).toBe("c:/code/acme");

    expect(s.projects.resolve({ workspacePath: "c:/code/ACME/" }).id).toBe(outer.id);
    expect(s.projects.resolve({ workspacePath: "C:\\Code\\acme\\apps\\server\\src" }).id).toBe(outer.id);
    expect(s.projects.resolve({ workspacePath: "C:\\Code\\acme\\apps\\web\\src" }).id).toBe(inner.id);
    expect(s.projects.resolve({ workspacePath: "/home/me/proj/sub" }).id).toBe(unix.id);
    // Segment boundary: a sibling folder sharing a prefix is not inside the project.
    expect(codeOf(() => s.projects.resolve({ workspacePath: "C:\\Code\\acme-old" }))).toBe("NOT_FOUND");
    expect(codeOf(() => s.projects.resolve({ workspacePath: "/home/me/PROJ" }))).toBe("NOT_FOUND");
    expect(codeOf(() => s.projects.resolve({}))).toBe("VALIDATION");
  });

  it("auto-creates unknown workspaces and rejects duplicates", () => {
    const { services: s, events } = createTestHarness();
    const created = s.projects.resolve({ workspacePath: "D:\\Repos\\api" }, { autoCreate: true });
    expect(created).toMatchObject({ title: "api", workspaceRoot: "D:\\Repos\\api" });
    expect(events).toEqual([{ type: "project.upserted", project: created }]);
    expect(s.projects.resolve({ workspacePath: "d:/repos/api" }, { autoCreate: true }).id).toBe(created.id);
    expect(codeOf(() => s.projects.create({ workspaceRoot: "d:\\repos\\API\\" }))).toBe("CONFLICT");
  });

  it("unarchives an archived project when its folder is re-added or auto-resolved", () => {
    const { services: s } = createTestHarness();
    const project = s.projects.create({ workspaceRoot: "D:/Repos/api" });
    s.projects.update(project.id, { archived: true });
    // Read-only resolve still finds the archived project without changing it.
    expect(s.projects.resolve({ workspacePath: "d:/repos/api" })).toMatchObject({ id: project.id });
    expect(s.projects.get(project.id).archivedAt).not.toBeNull();

    const readded = s.projects.create({ workspaceRoot: "d:/repos/API/" });
    expect(readded).toMatchObject({ id: project.id, archivedAt: null });

    s.projects.update(project.id, { archived: true });
    const resolved = s.projects.resolve({ workspacePath: "D:/Repos/api/src" }, { autoCreate: true });
    expect(resolved).toMatchObject({ id: project.id, archivedAt: null });
    expect(s.projects.list().map((p) => p.id)).toEqual([project.id]);
  });

  it("republishes a project's tasks when it is unarchived", () => {
    const { services: s, events } = createTestHarness();
    const project = s.projects.create({ title: "P" });
    const task = s.tasks.create({ projectId: project.id, title: "T" });
    const archivedTask = s.tasks.create({ projectId: project.id, title: "Old" });
    s.tasks.update(archivedTask.id, { archived: true }, "user");
    s.projects.update(project.id, { archived: true });
    events.length = 0;
    s.projects.update(project.id, { archived: false });
    expect(
      events.filter((e) => e.type === "task.upserted").map((e) => e.type === "task.upserted" && e.task.id),
    ).toEqual([task.id]);
  });

  it("reorders lanes", () => {
    const { services: s } = createTestHarness();
    const [a, b, c] = ["a", "b", "c"].map((title) => s.projects.create({ title }));
    s.projects.reorder([c!.id, a!.id, b!.id]);
    expect(s.projects.list().map((p) => p.title)).toEqual(["c", "a", "b"]);
  });
});

describe("links", () => {
  function setup() {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "P" });
    const task = h.services.tasks.create({ projectId: project.id, title: "T" });
    return { ...h, s: h.services, task };
  }

  it("classifies links and is idempotent on (task, kind, url)", () => {
    const { s, task } = setup();
    s.settings.update({ jiraBaseUrl: "https://acme.atlassian.net/" });
    const pr = s.links.add(task.id, { value: "https://github.com/acme/app/pull/12" }, "agent");
    expect(pr).toMatchObject({ kind: "pr", ref: { host: "github.com", repo: "acme/app", number: 12 } });
    const jira = s.links.add(task.id, { value: "pay-7" }, "agent");
    expect(jira).toMatchObject({ kind: "jira", url: "https://acme.atlassian.net/browse/PAY-7", ref: { key: "PAY-7" } });
    const thread = s.links.add(task.id, { t3Thread: { environmentId: "env", threadId: "th 1" } }, "agent");
    expect(thread).toMatchObject({ kind: "t3_thread", url: "t3code://threads/env/th%201" });
    expect(s.links.add(task.id, { value: "t3code://threads/env/th%201" }, "agent").id).toBe(thread.id);
    expect(s.links.add(task.id, { value: "https://github.com/acme/app/pull/12" }, "agent").id).toBe(pr.id);
    expect(s.links.add(task.id, { value: "https://example.com/x", kind: "pr" }, "agent")).toMatchObject({
      kind: "pr",
      ref: null,
    });
    expect(codeOf(() => s.links.add(task.id, { value: "hello" }, "agent"))).toBe("VALIDATION");
    expect(s.tasks.summary(task.id).links).toHaveLength(4);
    expect(s.tasks.detail(task.id).events.filter((e) => e.type === "link_added")).toHaveLength(4);
  });

  it("publishes snapshot changes only when the snapshot differs", () => {
    const { s, task, events } = setup();
    const pr = s.links.add(task.id, { value: "https://github.com/acme/app/pull/3" }, "agent");
    const snapshot: PrSnapshot = {
      state: "open",
      title: "Fix",
      checks: "failing",
      reviewDecision: null,
      mergeable: "mergeable",
      headRef: "fix",
      updatedAt: null,
    };
    events.length = 0;
    s.links.setSnapshot(pr.id, snapshot);
    expect(events.filter((e) => e.type === "task.upserted")).toHaveLength(1);
    s.links.setSnapshot(pr.id, { ...snapshot });
    expect(events.filter((e) => e.type === "task.upserted")).toHaveLength(1);
    expect(s.links.get(pr.id).syncedAt).not.toBeNull();
    expect(s.tasks.summary(task.id).attention.map((a) => a.kind)).toEqual(["pr_checks_failing"]);
    expect(s.links.listByKind("pr").map((l) => l.id)).toEqual([pr.id]);
  });
});

describe("settings", () => {
  it("never returns the token", () => {
    const { services: s } = createTestHarness();
    expect(s.settings.get()).toEqual({
      jiraBaseUrl: null,
      githubPolling: true,
      t3LinkTarget: "desktop",
      t3TokenSet: false,
    });
    const updated = s.settings.update({ t3Token: "secret", githubPolling: false });
    expect(updated).toMatchObject({ t3TokenSet: true, githubPolling: false });
    expect(JSON.stringify(updated)).not.toContain("secret");
    expect(s.settings.t3Token()).toBe("secret");
    expect(s.settings.update({ t3Token: null }).t3TokenSet).toBe(false);
  });
});

describe("repositoryRootOf", () => {
  it("walks up to the nearest .git directory", async () => {
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { repositoryRootOf } = await import("./projects.ts");
    const root = mkdtempSync(join(tmpdir(), "tb-repo-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    expect(repositoryRootOf(join(root, "apps", "web"))).toBe(root);
    expect(repositoryRootOf("Z:/does/not/exist")).toBe("Z:/does/not/exist");
  });
});
