import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunGit } from "../integrations/backup.ts";

// A pre-push hook for the worktrees Autopilot's headless agents work in. Codex and the Copilot CLI can't be given
// rules that refuse a force-push (Claude Code gets pushDenyRules), so git itself refuses it: every headless worktree
// gets a hooks folder of its own (`core.hooksPath` in the worktree's config) whose pre-push refuses force, delete and
// default-branch pushes. It is a guard rail, not a sandbox: `git push --no-verify` skips it, and the prompt says the
// same. See docs/features/autopilot.md#runners.

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
zero=0000000000000000000000000000000000000000
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
 * Gives the worktree its own hooks folder, inside its git dir so `git worktree remove` takes it along: a guarding
 * pre-push and, for every other hook, one that runs the repository's own. Needs `extensions.worktreeConfig`, which it
 * turns on for the repository (it only lets worktrees have config of their own).
 */
export async function installPushGuard(runGit: RunGit, worktree: string, defaultBranch: string | null): Promise<void> {
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
  const commonDir = resolve(worktree, await run(["rev-parse", "--git-common-dir"]));
  // A relative hooksPath is read from the worktree's top, where hooks run, so it stays as it is.
  const configured = (await runGit(["config", "--get", "core.hooksPath"], worktree)).stdout.trim();
  const original = configured || join(commonDir, "hooks");
  const hooks = join(gitDir, "autopilot-hooks");
  mkdirSync(hooks, { recursive: true });
  for (const name of CLIENT_HOOKS) {
    const script =
      name === "pre-push"
        ? prePushScript(defaultBranch, original.replace(/\\/g, "/"))
        : `#!/bin/sh\n${passOn(original.replace(/\\/g, "/"), name)}`;
    const path = join(hooks, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  await run(["config", "extensions.worktreeConfig", "true"]);
  await run(["config", "--worktree", "core.hooksPath", hooks.replace(/\\/g, "/")]);
}
