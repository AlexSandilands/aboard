import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunGit } from "../integrations/backup.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { pushGuardEnv } from "./pushGuard.ts";
import { canonicalPath, createWorktree, isInside, removeWorktree, type Worktree } from "./worktrees.ts";

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
    it("passes core.hooksPath on as one quoted key=value, after any parameters already set", () => {
      expect(pushGuardEnv("C:/w/.git/worktrees/x/autopilot-hooks", undefined)).toEqual({
        GIT_CONFIG_PARAMETERS: "'core.hooksPath=C:/w/.git/worktrees/x/autopilot-hooks'",
      });
      expect(pushGuardEnv("/r/it's/hooks", " 'user.name=A' ").GIT_CONFIG_PARAMETERS).toBe(
        "'user.name=A' 'core.hooksPath=/r/it'\\''s/hooks'",
      );
    });

    /** git as the agent runs it: with the guard's hooks in its environment. */
    const agentGit = (wt: Worktree, ...args: string[]) =>
      execFileSync("git", args, {
        cwd: wt.path,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...pushGuardEnv(wt.hooksPath!, process.env.GIT_CONFIG_PARAMETERS) },
      }).trim();
    const push = (wt: Worktree, ...args: string[]) => {
      try {
        agentGit(wt, "push", "--quiet", "origin", ...args);
        return "pushed";
      } catch (error) {
        return String((error as { stderr?: unknown }).stderr ?? error);
      }
    };
    const commit = (wt: Worktree, file: string) => {
      writeFileSync(join(wt.path, file), `${file}\n`);
      agentGit(wt, "add", file);
      agentGit(wt, "commit", "--quiet", "-m", file);
    };
    const guarded = (repoPath = repo.checkout) =>
      createWorktree(defaultRunGit, {
        repo: repoPath,
        root: repo.worktrees,
        taskNumber: 7,
        runId: RUN_ID,
        pushGuard: true,
      });

    it("refuses force, delete and default-branch pushes, and allows the run's own branch", async () => {
      const wt = await guarded();
      commit(wt, "one.txt");
      expect(push(wt, "-u", wt.branch)).toBe("pushed");
      commit(wt, "two.txt");
      expect(push(wt, wt.branch)).toBe("pushed");

      expect(push(wt, "HEAD:main")).toContain("default branch (main)");
      expect(push(wt, "HEAD:refs/heads/main")).toContain("default branch (main)");
      expect(push(wt, ":feature")).toContain("it deletes refs/heads/feature");
      expect(push(wt, "--delete", "feature")).toContain("it deletes");
      agentGit(wt, "commit", "--quiet", "--amend", "-m", "rewritten");
      expect(push(wt, "--force", wt.branch)).toContain("force-push");
      expect(push(wt, `+HEAD:${wt.branch}`)).toContain("force-push");
    });

    it("changes no config: the repository's and the worktree's stay as they were", async () => {
      const wt = await guarded();
      for (const key of ["core.hooksPath", "extensions.worktreeConfig"]) {
        expect(() => git(wt.path, "config", "--get", key)).toThrow("Command failed");
        expect(() => git(repo.checkout, "config", "--get", key)).toThrow("Command failed");
      }
    });

    it("guards a worktree of a bare repository, whose other worktrees keep working", async () => {
      const bare = join(repo.root, "bare.git");
      git(repo.root, "clone", "--quiet", "--bare", join(repo.root, "origin.git"), bare);
      const mine = join(repo.root, "mine");
      git(bare, "worktree", "add", "--quiet", mine, "feature");
      const wt = await guarded(mine);
      expect(git(mine, "status", "--short")).toBe("");
      expect(push(wt, ":feature")).toContain("it deletes");
    });

    it("still runs the repository's own hooks, wherever its hooksPath points", async () => {
      const hooks = join(repo.root, "my-hooks");
      mkdirSync(hooks);
      writeFileSync(join(hooks, "pre-commit"), '#!/bin/sh\necho ran > "$(git rev-parse --show-toplevel)/hook-ran"\n', {
        mode: 0o755,
      });
      writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho 'repo hook says no' >&2\nexit 1\n", { mode: 0o755 });
      // A `~` path, as a global setup would write it: git expands it, and so must the guard.
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const tilde = relative(home, hooks).startsWith("..") ? hooks : `~/${relative(home, hooks).replace(/\\/g, "/")}`;
      git(repo.checkout, "config", "core.hooksPath", tilde);
      const wt = await guarded();
      commit(wt, "one.txt");
      expect(existsSync(join(wt.path, "hook-ran"))).toBe(true);
      expect(push(wt, wt.branch)).toContain("repo hook says no");
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
