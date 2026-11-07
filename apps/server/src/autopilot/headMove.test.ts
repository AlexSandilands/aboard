import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRunGit, type RunGit } from "../integrations/backup.ts";
import { createGitFixture, git } from "../test/gitRepo.ts";
import { HeadMoveError, classifyHeadMove, fetchForHeadMove } from "./headMove.ts";

// Real git processes are slow on the Windows CI runner.
describe("classifying how a PR's head moved", { timeout: 30_000 }, () => {
  let repo: ReturnType<typeof createGitFixture>;
  // The user's checkout plays the PR author; `reader` is the board's checkout, which only sees what was pushed.
  let reader: string;
  beforeEach(() => {
    repo = createGitFixture();
    reader = join(repo.root, "reader");
    git(repo.root, "clone", "--quiet", repo.origin, reader);
  }, 30_000);
  afterEach(() => repo.cleanup());

  const commit = (branch: string, file: string, text: string, message = `edit ${file}`) => {
    git(repo.checkout, "checkout", "--quiet", branch);
    writeFileSync(join(repo.checkout, file), text);
    git(repo.checkout, "add", file);
    git(repo.checkout, "commit", "--quiet", "-m", message);
    git(repo.checkout, "push", "--quiet", "--force", "origin", branch);
    return git(repo.checkout, "rev-parse", "HEAD");
  };
  const head = (branch: string) => git(repo.checkout, "rev-parse", branch);
  /** Merges `from` into the feature branch and pushes it; `resolve` writes the files of a conflicted merge. */
  const mergeIntoFeature = (from: string, resolve?: () => void) => {
    git(repo.checkout, "checkout", "--quiet", "feature");
    try {
      git(repo.checkout, "merge", "--quiet", "--no-edit", from);
    } catch {
      resolve!();
      git(repo.checkout, "add", "-A");
      git(repo.checkout, "commit", "--quiet", "--no-edit");
    }
    git(repo.checkout, "push", "--quiet", "origin", "feature");
    return head("feature");
  };
  const classify = async (fromOid: string, toOid: string, runGit: RunGit = defaultRunGit) => {
    const input = { fromOid, toOid, baseRef: "main", headRef: "feature" };
    await fetchForHeadMove(runGit, reader, input);
    return classifyHeadMove(runGit, reader, input);
  };

  it("calls a merge of the base that git made on its own clean, through several merges", async () => {
    const reviewed = head("feature");
    commit("main", "other.txt", "other\n");
    mergeIntoFeature("main");
    commit("main", "third.txt", "third\n");
    const now = mergeIntoFeature("main");
    const move = await classify(reviewed, now);
    expect(move.kind).toBe("base_merge_clean");
    expect(move.kind === "base_merge_clean" && move.merges).toHaveLength(2);
  });

  it("calls a merge whose conflict was resolved by hand resolved, with the resolution's remerge-diff", async () => {
    commit("feature", "README.md", "feature's hello\n");
    const reviewed = head("feature");
    commit("main", "README.md", "main's hello\n");
    const now = mergeIntoFeature("main", () => writeFileSync(join(repo.checkout, "README.md"), "both hellos\n"));
    const move = await classify(reviewed, now);
    expect(move.kind).toBe("base_merge_resolved");
    if (move.kind !== "base_merge_resolved") return;
    expect(move.resolved).toEqual([now]);
    expect(move.diff).toContain("both hellos");
    expect(move.truncated).toBe(false);
  });

  it("calls an edit slipped into an otherwise clean merge resolved", async () => {
    const reviewed = head("feature");
    commit("main", "other.txt", "other\n");
    git(repo.checkout, "checkout", "--quiet", "feature");
    git(repo.checkout, "merge", "--quiet", "--no-commit", "main");
    writeFileSync(join(repo.checkout, "feature.txt"), "sneaky\n");
    git(repo.checkout, "add", "-A");
    git(repo.checkout, "commit", "--quiet", "--no-edit");
    git(repo.checkout, "push", "--quiet", "origin", "feature");
    const move = await classify(reviewed, head("feature"));
    expect(move.kind).toBe("base_merge_resolved");
    expect(move.kind === "base_merge_resolved" && move.diff).toContain("sneaky");
  });

  it("calls a commit of the PR's own after a base merge changed", async () => {
    const reviewed = head("feature");
    commit("main", "other.txt", "other\n");
    mergeIntoFeature("main");
    const now = commit("feature", "feature.txt", "more\n");
    expect(await classify(reviewed, now)).toMatchObject({ kind: "changed", reason: expect.stringContaining("own") });
  });

  it("calls a force-push that rewrote the reviewed commit changed", async () => {
    const reviewed = head("feature");
    git(repo.checkout, "checkout", "--quiet", "feature");
    git(repo.checkout, "commit", "--quiet", "--amend", "-m", "feature, reworded");
    git(repo.checkout, "push", "--quiet", "--force", "origin", "feature");
    expect(await classify(reviewed, head("feature"))).toMatchObject({
      kind: "changed",
      reason: expect.stringContaining("rewritten"),
    });
  });

  it("calls a merge of a branch that isn't the base changed", async () => {
    const reviewed = head("feature");
    git(repo.checkout, "checkout", "--quiet", "-b", "side", "main");
    commit("side", "side.txt", "side\n");
    const now = mergeIntoFeature("side");
    expect(await classify(reviewed, now)).toMatchObject({
      kind: "changed",
      reason: expect.stringContaining("isn't main"),
    });
  });

  it("calls the base merged the other way round (the PR's commits on top of the base) changed", async () => {
    const reviewed = head("feature");
    commit("main", "other.txt", "other\n");
    git(repo.checkout, "checkout", "--quiet", "-b", "flipped", "main");
    git(repo.checkout, "merge", "--quiet", "--no-edit", "feature");
    git(repo.checkout, "push", "--quiet", "--force", "origin", "flipped:feature");
    expect((await classify(reviewed, head("flipped"))).kind).toBe("changed");
  });

  it("treats a merge a git without merge-tree --write-tree can't check as resolved", async () => {
    const reviewed = head("feature");
    commit("main", "other.txt", "other\n");
    const now = mergeIntoFeature("main");
    const oldGit: RunGit = (args, cwd) =>
      args[0] === "merge-tree" || args.includes("--remerge-diff")
        ? Promise.resolve({ code: 129, stdout: "", stderr: "unknown option" })
        : defaultRunGit(args, cwd);
    expect(await classify(reviewed, now, oldGit)).toMatchObject({ kind: "base_merge_resolved", diff: null });
  });

  it("throws, rather than guessing, when git doesn't have the commit", async () => {
    await expect(
      classifyHeadMove(defaultRunGit, reader, { fromOid: "a".repeat(40), toOid: head("feature"), baseRef: "main" }),
    ).rejects.toThrow(HeadMoveError);
  });
});
