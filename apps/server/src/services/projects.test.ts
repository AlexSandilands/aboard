import type { PrSnapshot } from "@repo/contracts";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";
import { repositoryRootOf } from "./projects.ts";
import { defaultSettings, TEST_JIRA } from "../test/fixtures.ts";

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

  it("creates a project from a title alone, with no folder to resolve it by", () => {
    const { services: s } = createTestHarness();
    const general = s.projects.create({ title: "General" });
    expect(general).toMatchObject({ title: "General", workspaceRoot: null, workspaceKey: null });
    // Two folderless projects never conflict, and no workspace path resolves to either.
    expect(s.projects.create({ title: "Other" }).workspaceKey).toBeNull();
    expect(codeOf(() => s.projects.resolve({ workspacePath: "/home/me/proj" }))).toBe("NOT_FOUND");
    expect(codeOf(() => s.projects.create({}))).toBe("VALIDATION");
  });

  describe("General", () => {
    it("is made once on start, with no folder, and a second start keeps it", () => {
      const { services: s } = createTestHarness();
      expect(s.projects.list()).toEqual([]);
      s.projects.ensureGeneral();
      const [general, ...rest] = s.projects.list();
      expect(rest).toEqual([]);
      expect(general).toMatchObject({ title: "General", workspaceRoot: null, archivedAt: null });
      s.projects.ensureGeneral();
      expect(s.projects.list().map((p) => p.id)).toEqual([general!.id]);
      expect(s.projects.general().id).toBe(general!.id);
    });

    it("keeps a rename, and an archive or delete is not undone by the next start", () => {
      const { services: s } = createTestHarness();
      s.projects.ensureGeneral();
      const general = s.projects.general();
      s.projects.update(general.id, { title: "Inbox" });
      s.projects.ensureGeneral();
      expect(s.projects.list().map((p) => p.title)).toEqual(["Inbox"]);

      s.projects.update(general.id, { archived: true });
      s.projects.ensureGeneral();
      expect(s.projects.list()).toEqual([]);
      expect(s.projects.list({ includeArchived: true })).toHaveLength(1);

      s.projects.delete(general.id);
      s.projects.ensureGeneral();
      expect(s.projects.list({ includeArchived: true })).toEqual([]);
    });

    it("is brought back by general() when archived, and made again when deleted", () => {
      const { services: s } = createTestHarness();
      s.projects.ensureGeneral();
      const general = s.projects.general();
      s.projects.update(general.id, { archived: true });
      expect(s.projects.general()).toMatchObject({ id: general.id, archivedAt: null });

      s.projects.delete(general.id);
      const again = s.projects.general();
      expect(again).toMatchObject({ title: "General", workspaceRoot: null });
      expect(again.id).not.toBe(general.id);
      expect(s.projects.general().id).toBe(again.id);
    });

    it("stays the last lane while projects are added, until the user moves it", () => {
      const { services: s } = createTestHarness();
      s.projects.ensureGeneral();
      const a = s.projects.create({ title: "a" });
      const b = s.projects.create({ title: "b" });
      const general = s.projects.general();
      expect(s.projects.list().map((p) => p.title)).toEqual(["a", "b", "General"]);

      s.projects.reorder([general.id, a.id, b.id]);
      const c = s.projects.create({ title: "c" });
      expect(s.projects.list().map((p) => p.id)).toEqual([general.id, a.id, b.id, c.id]);
    });
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
    s.settings.update({ ticketSystems: [{ ...TEST_JIRA, linkTemplate: "https://acme.atlassian.net/browse/{key}" }] });
    const pr = s.links.add(task.id, { value: "https://github.com/acme/app/pull/12" }, "agent");
    expect(pr).toMatchObject({ kind: "pr", ref: { host: "github.com", repo: "acme/app", number: 12 } });
    const ticket = s.links.add(task.id, { value: "pay-7" }, "agent");
    expect(ticket).toMatchObject({
      kind: "ticket",
      url: "https://acme.atlassian.net/browse/PAY-7",
      ref: { system: "jira", key: "PAY-7" },
    });
    expect(s.links.add(task.id, { value: "https://acme.atlassian.net/browse/PAY-7?focus=1" }, "agent").id).toBe(
      ticket.id,
    );
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
    expect(s.settings.get()).toEqual(defaultSettings);
    const updated = s.settings.update({ t3Token: "secret", githubPolling: false });
    expect(updated).toMatchObject({ t3TokenSet: true, githubPolling: false });
    expect(JSON.stringify(updated)).not.toContain("secret");
    expect(s.settings.t3Token()).toBe("secret");
    expect(s.settings.update({ t3Token: null }).t3TokenSet).toBe(false);
  });
});

describe("repositoryRootOf", () => {
  it("walks up to the nearest .git directory", () => {
    const root = mkdtempSync(join(tmpdir(), "tb-repo-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "apps", "web"), { recursive: true });
    expect(repositoryRootOf(join(root, "apps", "web"))).toBe(root);
    expect(repositoryRootOf("Z:/does/not/exist")).toBe("Z:/does/not/exist");
  });
});
