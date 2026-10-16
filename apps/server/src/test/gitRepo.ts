import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A repository to make worktrees from, using the machine's real git with its global and system config shut out:
 * a bare `origin` with `main` and a `feature` branch, and a clone of it as the user's checkout. `root` is a temp
 * folder holding both, plus `worktrees` for Autopilot's. Call `cleanup` when done.
 */
export function createGitFixture() {
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const root = mkdtempSync(join(tmpdir(), `${BRAND.id}-worktrees-`));
  const config = join(root, ".gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";

  const origin = join(root, "origin.git");
  const checkout = join(root, "app");
  mkdirSync(origin);
  mkdirSync(checkout);
  git(origin, "init", "--quiet", "--bare");
  git(checkout, "clone", "--quiet", origin, ".");
  writeFileSync(join(checkout, "README.md"), "hello\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "--quiet", "-m", "first");
  git(checkout, "push", "--quiet", "origin", "main");
  git(checkout, "checkout", "--quiet", "-b", "feature");
  writeFileSync(join(checkout, "feature.txt"), "feature\n");
  git(checkout, "add", "feature.txt");
  git(checkout, "commit", "--quiet", "-m", "feature");
  git(checkout, "push", "--quiet", "origin", "feature");
  git(checkout, "checkout", "--quiet", "main");
  // A clone's origin/HEAD is set only when the remote had a branch at clone time.
  git(checkout, "remote", "set-head", "origin", "main");

  return {
    root,
    origin,
    checkout,
    worktrees: join(root, "worktrees"),
    cleanup() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
