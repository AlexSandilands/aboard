import { normalizeWorkspaceKey, type PrSnapshot } from "@repo/contracts";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.ts";
import { createTestHarness } from "../test/harness.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { mainCheckoutOf, repositoryRootOf } from "./projects.ts";
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
    it("is named on the board snapshot, once there is one", () => {
      const { services: s } = createTestHarness();
      expect(s.board.snapshot().generalProjectId).toBeNull();
      s.projects.ensureGeneral();
      expect(s.board.snapshot().generalProjectId).toBe(s.projects.general().id);
    });

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
      url: "PAY-7",
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

describe("git worktrees", () => {
  /** A checkout with `apps/web` and a linked worktree of it, both by their real paths (git writes those). */
  const withWorktree = (
    fn: (paths: { main: string; worktree: string }) => void,
    opts: { insideMain?: boolean } = {},
  ) => {
    const fx = createGitFixture();
    try {
      const main = realpathSync.native(fx.checkout);
      mkdirSync(join(main, "apps", "web"), { recursive: true });
      writeFileSync(join(main, "apps", "web", "keep"), "");
      git(main, "add", ".");
      git(main, "commit", "--quiet", "-m", "web");
      // Claude Code puts its worktrees inside the repo, under .claude/worktrees.
      const worktree = opts.insideMain
        ? join(main, ".claude", "worktrees", "wt")
        : join(realpathSync.native(fx.root), "wt");
      git(main, "worktree", "add", "--quiet", "-b", "wt", worktree);
      fn({ main, worktree });
    } finally {
      fx.cleanup();
    }
  };
  const key = (path: string | null | undefined) => (path ? normalizeWorkspaceKey(path) : null);

  it("maps a path in a linked worktree to the same path in the main checkout", () => {
    withWorktree(({ main, worktree }) => {
      expect(key(mainCheckoutOf(worktree)?.path)).toBe(key(main));
      const nested = mainCheckoutOf(join(worktree, "apps", "web"));
      expect(key(nested?.path)).toBe(key(join(main, "apps", "web")));
      expect(key(nested?.worktree)).toBe(key(worktree));
      expect(key(nested?.main)).toBe(key(main));
      // The main checkout itself, a non-repo folder and a missing path aren't worktrees.
      expect(mainCheckoutOf(main)).toBeNull();
      expect(mainCheckoutOf(mkdtempSync(join(tmpdir(), "tb-plain-")))).toBeNull();
      expect(mainCheckoutOf("Z:/does/not/exist")).toBeNull();
    });
  });

  it("doesn't map submodules or worktrees of a bare repository", () => {
    const fx = createGitFixture();
    try {
      // A submodule's .git file points at its gitdir, which has no commondir.
      const sub = join(fx.root, "sub");
      mkdirSync(join(fx.root, "modules", "sub"), { recursive: true });
      mkdirSync(sub);
      writeFileSync(join(sub, ".git"), `gitdir: ${join(fx.root, "modules", "sub")}\n`);
      expect(mainCheckoutOf(sub)).toBeNull();
      const bareWorktree = join(fx.root, "bare-wt");
      git(fx.origin, "worktree", "add", "--quiet", bareWorktree, "main");
      expect(mainCheckoutOf(bareWorktree)).toBeNull();
    } finally {
      fx.cleanup();
    }
  });

  it("resolves a worktree path to the main checkout's project, deepest first", () => {
    withWorktree(({ main, worktree }) => {
      const { services: s } = createTestHarness();
      const repo = s.projects.create({ workspaceRoot: main });
      const web = s.projects.create({ workspaceRoot: join(main, "apps", "web") });
      expect(s.projects.resolve({ workspacePath: worktree }).id).toBe(repo.id);
      expect(s.projects.resolve({ workspacePath: join(worktree, "apps", "web") }).id).toBe(web.id);
      expect(s.projects.resolveOrCreate({ workspacePath: worktree })).toEqual({ project: repo, created: false });
      expect(s.projects.list()).toHaveLength(2);
    });
  });

  it("finds the deepest main-checkout project for a worktree inside the main repo", () => {
    withWorktree(
      ({ main, worktree }) => {
        const { services: s } = createTestHarness();
        const repo = s.projects.create({ workspaceRoot: main });
        const web = s.projects.create({ workspaceRoot: join(main, "apps", "web") });
        // The worktree path lies inside the repo's own project, but the mapped path is deeper.
        expect(s.projects.resolve({ workspacePath: join(worktree, "apps", "web") }).id).toBe(web.id);
        expect(s.projects.resolve({ workspacePath: worktree }).id).toBe(repo.id);
      },
      { insideMain: true },
    );
  });

  it("prefers a project bound to the worktree itself", () => {
    withWorktree(({ main, worktree }) => {
      const { services: s } = createTestHarness();
      s.projects.create({ workspaceRoot: main });
      const bound = s.projects.create({ workspaceRoot: worktree });
      expect(s.projects.resolve({ workspacePath: join(worktree, "apps") }).id).toBe(bound.id);
    });
  });

  it("creates an unknown worktree's project at the main checkout", () => {
    withWorktree(({ main, worktree }) => {
      const { services: s } = createTestHarness();
      const { project, created } = s.projects.resolveOrCreate({ workspacePath: join(worktree, "apps", "web") });
      expect(created).toBe(true);
      expect(key(project.workspaceRoot)).toBe(key(main));
      expect(project.title).toBe("app");
      expect(s.projects.list()).toHaveLength(1);
      // A path outside any repo is still created as given.
      const plain = mkdtempSync(join(tmpdir(), "tb-plain-"));
      expect(s.projects.resolveOrCreate({ workspacePath: plain }).project.workspaceRoot).toBe(plain);
    });
  });
});

describe("git worktrees on another branch", () => {
  it("creates the project at the main checkout's root for a folder only the worktree's branch has", () => {
    const fx = createGitFixture();
    try {
      const main = realpathSync.native(fx.checkout);
      const worktree = join(realpathSync.native(fx.root), "wt");
      git(main, "worktree", "add", "--quiet", "-b", "wt", worktree);
      const fresh = join(worktree, "packages", "new");
      mkdirSync(fresh, { recursive: true });
      const { services: s } = createTestHarness();
      const { project, created } = s.projects.resolveOrCreate({ workspacePath: fresh });
      expect(created).toBe(true);
      expect(normalizeWorkspaceKey(project.workspaceRoot!)).toBe(normalizeWorkspaceKey(main));
    } finally {
      fx.cleanup();
    }
  });
});
