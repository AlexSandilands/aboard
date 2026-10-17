import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunGit } from "../integrations/backup.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { ensureEpicBranch } from "./epicBranch.ts";
import { createWorktree } from "./worktrees.ts";

// Real git processes are slow on the Windows CI runner.
describe("an epic's integration branch", { timeout: 30_000 }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  beforeEach(() => {
    repo = createGitFixture();
  }, 30_000);
  afterEach(() => repo.cleanup());

  it("is made on origin from origin's default branch, and used as it is the next time", async () => {
    const made = await ensureEpicBranch(defaultRunGit, repo.checkout, "epic/4-checkout");
    expect(made).toEqual({ branch: "epic/4-checkout", defaultBranch: "main", created: true });
    expect(git(repo.origin, "rev-parse", "epic/4-checkout")).toBe(git(repo.origin, "rev-parse", "main"));
    // The user's checkout stays on its branch and gets no local branch.
    expect(git(repo.checkout, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo.checkout, "branch", "--list", "epic/*")).toBe("");

    const again = await ensureEpicBranch(defaultRunGit, repo.checkout, "epic/4-checkout");
    expect(again.created).toBe(false);
  });

  it("refuses the default branch and option-like names", async () => {
    await expect(ensureEpicBranch(defaultRunGit, repo.checkout, "main")).rejects.toThrow("default branch (main)");
    await expect(ensureEpicBranch(defaultRunGit, repo.checkout, "-x")).rejects.toThrow("Not a branch name");
  });

  it("gives a task's worktree origin's copy of the epic's branch, past a stale local one", async () => {
    await ensureEpicBranch(defaultRunGit, repo.checkout, "epic/4-checkout");
    // A local branch of the same name, left behind at an older commit.
    git(repo.checkout, "branch", "epic/4-checkout", "main");
    git(repo.checkout, "push", "--quiet", "origin", "feature:epic/4-checkout");
    const wt = await createWorktree(defaultRunGit, {
      repo: repo.checkout,
      root: repo.worktrees,
      taskNumber: 5,
      runId: "abcdef12-3456-4789-8abc-def012345678",
      baseRef: "epic/4-checkout",
      baseFromOrigin: true,
    });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(git(repo.origin, "rev-parse", "feature"));
  });
});
