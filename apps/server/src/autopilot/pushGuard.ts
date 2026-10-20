import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunGit } from "../integrations/backup.ts";

// A pre-push hook for the worktrees Autopilot's headless agents work in. Codex and the Copilot CLI can't be given
// rules that refuse a force-push (Claude Code gets pushDenyRules), so git itself refuses it: every headless worktree
// gets a hooks folder of its own whose pre-push refuses force, delete and default-branch pushes. The agent's process
// points git at it (pushGuardEnv), so neither the repository's config nor the user's own git commands change. It is a
// guard rail, not a sandbox: `git push --no-verify` skips it, and the prompt says the same. See
// docs/features/autopilot.md#the-push-guard.

/** The client hooks git runs, each passed on to the repository's own so its checks (lint, commit messages) still run. */
const CLIENT_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "post-rewrite",
  "reference-transaction",
  "post-index-change",
  "sendemail-validate",
  "push-to-checkout",
];

/** Single-quoted for sh. */
const shQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Runs the repository's own hook of the same name, when it has one. `stdin` names a file to feed it. */
const passOn = (original: string, name: string, stdin?: string) =>
  `hook=${shQuote(`${original}/${name}`)}
if [ -x "$hook" ]; then
  "$hook" "$@"${stdin ? ` < "${stdin}"` : ""}
  exit $?
fi
exit 0
`;

/**
 * The pre-push hook. git feeds it one line per ref: `<local ref> <local sha> <remote ref> <remote sha>`. A local sha of
 * zeros deletes the remote ref; a remote sha that isn't an ancestor of the local one is a force-push (one git doesn't
 * know can't be told apart, so it is refused too: fetch first).
 */
export function prePushScript(defaultBranch: string | null, original: string): string {
  const refuse = (why: string) => `echo "Autopilot refused this push: ${why}" >&2; exit 1`;
  return `#!/bin/sh
# Installed by Autopilot: refuses force, delete and default-branch pushes from this worktree.
input=$(mktemp)
trap 'rm -f "$input"' EXIT
cat > "$input"
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$remote_ref" ] && continue
  case "$local_sha" in *[!0]*) ;; *) ${refuse("it deletes $remote_ref")} ;; esac
${
  defaultBranch
    ? `  if [ "$remote_ref" = ${shQuote(`refs/heads/${defaultBranch}`)} ]; then ${refuse(`it pushes to the default branch (${defaultBranch.replace(/["$`\\]/g, "")})`)}; fi\n`
    : ""
}  case "$remote_sha" in *[!0]*)
    if ! git cat-file -e "$remote_sha^{commit}" 2>/dev/null; then ${refuse("$remote_ref has commits this worktree hasn't fetched, so it may be a force-push")}; fi
    if ! git merge-base --is-ancestor "$remote_sha" "$local_sha"; then ${refuse("it rewrites $remote_ref (a force-push)")}; fi
    ;;
  esac
done < "$input"
${passOn(original, "pre-push", "$input")}`;
}

/**
 * Writes the worktree's hooks folder, inside its git dir so `git worktree remove` takes it along: a guarding pre-push
 * and, for every other hook, one that runs the repository's own (where git would look for them: `core.hooksPath`, `~`
 * expanded, else the common dir's hooks). Returns the folder, for pushGuardEnv.
 */
export async function installPushGuard(
  runGit: RunGit,
  worktree: string,
  defaultBranch: string | null,
): Promise<string> {
  const run = async (args: string[]) => {
    const result = await runGit(args, worktree);
    if (result.code !== 0) {
      throw new Error(
        `Couldn't guard the worktree's pushes: ${(result.stderr || result.stdout).trim() || "git failed"}`,
      );
    }
    return result.stdout.trim();
  };
  const gitDir = resolve(worktree, await run(["rev-parse", "--git-dir"]));
  // Relative to the worktree's top, where git runs hooks; `--path-format=absolute` would need git 2.31.
  const original = resolve(worktree, await run(["rev-parse", "--git-path", "hooks"])).replace(/\\/g, "/");
  const hooks = join(gitDir, "autopilot-hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of CLIENT_HOOKS) {
    const script =
      name === "pre-push" ? prePushScript(defaultBranch, original) : `#!/bin/sh\n${passOn(original, name)}`;
    const path = join(hooks, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  return hooks.replace(/\\/g, "/");
}

/**
 * The environment that points the agent's git at the guard's hooks: `core.hooksPath` the way `git -c` passes it on
 * (`GIT_CONFIG_PARAMETERS`), so every git the agent starts gets it and nothing is written to any config. Not
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`: Codex drops variables with `KEY` in their name from its shell, and git
 * fails outright when a counted key is missing. Kept after any parameters already set, which they would otherwise
 * override.
 */
export function pushGuardEnv(hooks: string, existing: string | undefined): { GIT_CONFIG_PARAMETERS: string } {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const own = `${quote("core.hooksPath")}=${quote(hooks)}`;
  return { GIT_CONFIG_PARAMETERS: existing?.trim() ? `${existing.trim()} ${own}` : own };
}
