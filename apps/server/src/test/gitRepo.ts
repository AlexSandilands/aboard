import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "@repo/contracts";
import { afterAll } from "vitest";

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The repositories as built once per test file, and copied for each fixture. */
let template: string | null = null;

// Registered when a test file imports this module, so no file has to remember it. Modules are isolated per file.
afterAll(() => {
  if (template) rmSync(template, { recursive: true, force: true });
  template = null;
});

/** Every way git may write `path` into its config: as given, with escaped backslashes, and with forward slashes. */
const pathSpellings = (path: string) => [path, path.replaceAll("\\", "\\\\"), path.replaceAll("\\", "/")];

function buildTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), `${BRAND.id}-worktrees-template-`));
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const config = join(root, ".gitconfig");
  writeFileSync(config, "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
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
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return root;
}

/**
 * A repository to make worktrees from, using the machine's real git with its global and system config shut out:
 * a bare `origin` with `main` and a `feature` branch, and a clone of it as the user's checkout. `root` is a temp
 * folder holding both, plus `worktrees` for Autopilot's. Call `cleanup` when done (the template is removed after the file).
 *
 * Building the repositories takes a dozen git processes, which is most of a test's time on a loaded Windows
 * machine. They are built once per file, and each fixture is a copy with the clone's remote pointed at its own
 * `origin`, which costs no processes.
 */
export function createGitFixture() {
  template ??= buildTemplate();
  const root = mkdtempSync(join(tmpdir(), `${BRAND.id}-worktrees-`));
  const origin = join(root, "origin.git");
  const checkout = join(root, "app");
  try {
    cpSync(template, root, { recursive: true });
    const checkoutConfig = join(checkout, ".git", "config");
    let text = readFileSync(checkoutConfig, "utf8");
    const from = pathSpellings(join(template, "origin.git"));
    const to = pathSpellings(origin);
    if (!from.some((spelling) => text.includes(spelling))) throw new Error(`Template remote not found in ${text}`);
    from.forEach((spelling, i) => {
      text = text.replaceAll(spelling, to[i]!);
    });
    writeFileSync(checkoutConfig, text);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = join(root, ".gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";

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
