import type { GitResult, RunGit } from "../integrations/backup.ts";

/** How a head was reached from the one before it, as `classifyHeadMove` would find it. */
export type FakeMove = "clean" | "resolved" | "changed";

/** The base branch's tip in the fake history. */
const BASE_TIP = "ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e";

/**
 * Git as Review PRs' head-move classifier reads it, for tests that don't want real repositories: each head declared
 * with `move(from, to, kind)` is one merge of the base branch on top of `from`, which git merged on its own (`clean`),
 * with conflicts resolved by hand (`resolved`), or isn't a merge of the base at all (`changed`). A head nobody
 * declared isn't a descendant of anything, so it reads as a rewrite. `calls` lists every command run.
 */
export function fakeHeadMoveGit() {
  const moves = new Map<string, { from: string; kind: FakeMove }>();
  const calls: string[][] = [];
  const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
  const no: GitResult = { code: 1, stdout: "", stderr: "" };
  const runGit: RunGit = async (args) => {
    calls.push(args);
    switch (args[0]) {
      case "fetch":
        return ok();
      case "rev-parse":
        return args[1] === "--verify" ? ok() : ok(`tree-of-${args[1]!.replace("^{tree}", "")}\n`);
      case "merge-base": {
        const [, , ancestor, of] = args as [string, string, string, string];
        if (of.startsWith("refs/remotes/origin/")) return ancestor === BASE_TIP ? ok() : no;
        const move = moves.get(of);
        return move && move.from === ancestor && move.kind !== "changed" ? ok() : no;
      }
      case "rev-list": {
        const [from, to] = args[3]!.split("..") as [string, string];
        return ok(`${to} ${from} ${BASE_TIP}\n`);
      }
      case "merge-tree": {
        const first = args[3]!;
        const to = [...moves].find(([, m]) => m.from === first)?.[0] ?? "";
        return moves.get(to)?.kind === "clean" ? ok(`tree-of-${to}\n`) : { code: 1, stdout: "tree-auto\n", stderr: "" };
      }
      case "show":
        return ok(
          `commit ${args.at(-1)}\nMerge the base\n\ndiff --cc src/a.ts\n-<<<<<<< ours\n+const both = true; // resolved by hand\n`,
        );
      default:
        return { code: 128, stdout: "", stderr: `fake git doesn't know ${args[0]}` };
    }
  };
  return {
    runGit,
    calls,
    move: (from: string, to: string, kind: FakeMove) => moves.set(to, { from, kind }),
  };
}
