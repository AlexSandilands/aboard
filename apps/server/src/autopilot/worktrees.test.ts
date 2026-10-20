import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunGit } from "../integrations/backup.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { canonicalPath, createWorktree, isInside, removeWorktree } from "./worktrees.ts";

const RUN_ID = "abcdef12-3456-4789-8abc-def012345678";

// Real git processes are slow on a loaded Windows machine.
describe("Autopilot worktrees", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  // The first fixture in a file builds the template repositories, a dozen git processes.
  beforeEach(() => {
    repo = createGitFixture();
  }, PROCESS_TEST_TIMEOUT);
  afterEach(() => repo.cleanup());

  const make = (extra: { baseRef?: string; branch?: string; root?: string } = {}) =>
    createWorktree(defaultRunGit, {
      repo: repo.checkout,
      root: extra.root ?? repo.worktrees,
      taskNumber: 7,
      runId: RUN_ID,
      ...extra,
    });

  it("starts a new untracked branch from origin's default branch, outside the checkout", async () => {
    const wt = await make();
    expect(wt).toMatchObject({ branch: "autopilot/7-abcdef12", pushTo: "autopilot/7-abcdef12", defaultBranch: "main" });
    expect(wt.path).toBe(join(repo.worktrees, "app", "7-abcdef12"));
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(git(repo.checkout, "rev-parse", "origin/main"));
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("autopilot/7-abcdef12");
    // No upstream, so a bare `git push` can't land on main.
    expect(() => git(wt.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow("no upstream");
    // The user's checkout is untouched.
    expect(git(repo.checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("starts from an existing branch's tip and pushes back to it", async () => {
    const wt = await make({ branch: "feature" });
    expect(wt.pushTo).toBe("feature");
    expect(wt.branch).toBe("autopilot/7-abcdef12");
    expect(existsSync(join(wt.path, "feature.txt"))).toBe(true);
  });

  it("takes a base ref", async () => {
    const wt = await make({ baseRef: "origin/feature" });
    expect(wt.pushTo).toBe(wt.branch);
    expect(existsSync(join(wt.path, "feature.txt"))).toBe(true);
  });

  it("refuses the default branch, option-like refs, unknown branches and folders in the checkout", async () => {
    await expect(make({ branch: "main" })).rejects.toThrow("default branch (main)");
    await expect(make({ branch: "--upload-pack=x" })).rejects.toThrow("Not a branch name");
    await expect(make({ baseRef: "-b" })).rejects.toThrow("Not a branch name");
    await expect(make({ branch: "nope" })).rejects.toThrow("No branch nope");
    await expect(make({ root: join(repo.checkout, ".wt") })).rejects.toThrow("overlaps the checkout");
    await expect(make({ root: repo.root })).rejects.toThrow("overlaps the checkout");
    await expect(
      createWorktree(defaultRunGit, { repo: repo.origin, root: repo.worktrees, taskNumber: 1, runId: RUN_ID }),
    ).rejects.toThrow("isn't a git repository");
    await expect(
      createWorktree(defaultRunGit, { repo: repo.worktrees, root: repo.root, taskNumber: 1, runId: RUN_ID }),
    ).rejects.toThrow("doesn't exist");
  });

  it("removes clean worktrees and their merged branch, and keeps dirty ones", async () => {
    const wt = await make();
    writeFileSync(join(wt.path, "wip.txt"), "unsaved\n");
    expect(await removeWorktree(defaultRunGit, wt.path)).toBe("dirty");
    expect(existsSync(wt.path)).toBe(true);

    git(wt.path, "clean", "--quiet", "-f");
    expect(await removeWorktree(defaultRunGit, wt.path)).toBe("removed");
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo.checkout, "branch", "--list", "autopilot/*")).toBe("");
    expect(await removeWorktree(defaultRunGit, wt.path)).toBe("missing");
  });

  it("keeps a branch with unmerged commits when its worktree goes", async () => {
    const wt = await make();
    writeFileSync(join(wt.path, "work.txt"), "done\n");
    git(wt.path, "add", "work.txt");
    git(wt.path, "commit", "--quiet", "-m", "work");
    expect(await removeWorktree(defaultRunGit, wt.path)).toBe("removed");
    expect(git(repo.checkout, "branch", "--list", "autopilot/*")).toContain("autopilot/7-abcdef12");
  });

  describe("the push guard", () => {
    const push = (cwd: string, ...args: string[]) => {
      try {
        git(cwd, "push", "--quiet", "origin", ...args);
        return "pushed";
      } catch (error) {
        return String((error as { stderr?: unknown }).stderr ?? error);
      }
    };
    const commit = (cwd: string, file: string) => {
      writeFileSync(join(cwd, file), `${file}\n`);
      git(cwd, "add", file);
      git(cwd, "commit", "--quiet", "-m", file);
    };

    it("refuses force, delete and default-branch pushes, and allows the run's own branch", async () => {
      const wt = await createWorktree(defaultRunGit, {
        repo: repo.checkout,
        root: repo.worktrees,
        taskNumber: 7,
        runId: RUN_ID,
        pushGuard: true,
      });
      commit(wt.path, "one.txt");
      expect(push(wt.path, "-u", wt.branch)).toBe("pushed");
      commit(wt.path, "two.txt");
      expect(push(wt.path, wt.branch)).toBe("pushed");

      expect(push(wt.path, "HEAD:main")).toContain("default branch (main)");
      expect(push(wt.path, "HEAD:refs/heads/main")).toContain("default branch (main)");
      expect(push(wt.path, ":feature")).toContain("it deletes refs/heads/feature");
      expect(push(wt.path, "--delete", "feature")).toContain("it deletes");
      git(wt.path, "commit", "--quiet", "--amend", "-m", "rewritten");
      expect(push(wt.path, "--force", wt.branch)).toContain("force-push");
      expect(push(wt.path, `+HEAD:${wt.branch}`)).toContain("force-push");
      // The user's checkout keeps its own hooks.
      expect(() => git(repo.checkout, "config", "--get", "core.hooksPath")).toThrow("Command failed");
    });

    it("still runs the repository's own hooks", async () => {
      const hooks = join(repo.checkout, ".git", "hooks");
      writeFileSync(join(hooks, "pre-commit"), '#!/bin/sh\necho ran > "$(git rev-parse --show-toplevel)/hook-ran"\n', {
        mode: 0o755,
      });
      writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho 'repo hook says no' >&2\nexit 1\n", { mode: 0o755 });
      const wt = await createWorktree(defaultRunGit, {
        repo: repo.checkout,
        root: repo.worktrees,
        taskNumber: 7,
        runId: RUN_ID,
        pushGuard: true,
      });
      commit(wt.path, "one.txt");
      expect(existsSync(join(wt.path, "hook-ran"))).toBe(true);
      expect(push(wt.path, wt.branch)).toContain("repo hook says no");
    });
  });

  it("tells whether a folder is inside another", () => {
    expect(isInside(join("a", "b"), "a")).toBe(true);
    expect(isInside("a", "a")).toBe(true);
    expect(isInside("ab", "a")).toBe(false);
    expect(isInside("a", join("a", "b"))).toBe(false);
  });

  it("names a folder the way the file system does, keeping the part that doesn't exist yet", () => {
    const real = realpathSync.native(repo.root);
    expect(canonicalPath(join(repo.root, "not", "yet"))).toBe(join(real, "not", "yet"));
    expect(canonicalPath(join(repo.root, "x", ".."))).toBe(real);
  });
});
