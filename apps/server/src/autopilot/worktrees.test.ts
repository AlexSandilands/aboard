import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunGit } from "../integrations/backup.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { createWorktree, isInside, removeWorktree } from "./worktrees.ts";

const RUN_ID = "abcdef12-3456-4789-8abc-def012345678";

// Real git processes are slow on the Windows CI runner.
describe("Autopilot worktrees", { timeout: 30_000 }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  beforeEach(() => {
    repo = createGitFixture();
  });
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

  it("tells whether a folder is inside another", () => {
    expect(isInside(join("a", "b"), "a")).toBe(true);
    expect(isInside("a", "a")).toBe(true);
    expect(isInside("ab", "a")).toBe(false);
    expect(isInside("a", join("a", "b"))).toBe(false);
  });
});
