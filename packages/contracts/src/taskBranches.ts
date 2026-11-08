import { z } from "zod";
import { AGENT_HARNESSES } from "./agentSessions.ts";
import type { TaskLink } from "./schemas.ts";

// The branches a task's work is on, pinned at the top of the hand-off dialogs' branch pickers. They come from the
// task's links (a PR's head, a T3 thread's branch, the branch an agent session's folder has checked out), worked out
// when the dialog loads. See docs/features/agent-handoff.md#the-tasks-branches.

/** Where the board found a task's branch: one chip in the picker, e.g. "PR #61 open" or "Codex session". */
export const TaskBranchSource = z.object({
  kind: z.enum(["pr", "t3_thread", "agent_session"]),
  label: z.string(),
  /** A merged or closed PR: the work there is over. */
  inactive: z.boolean(),
});
export type TaskBranchSource = z.infer<typeof TaskBranchSource>;

export const TaskBranch = z.object({
  /** The local branch name, without `origin/`. */
  name: z.string().min(1),
  sources: z.array(TaskBranchSource).min(1),
  /** The worktree that has the branch checked out, other than the project's own folder; null when none does. */
  worktreePath: z.string().nullable(),
  /** Every source is inactive: listed last, dimmed. */
  inactive: z.boolean(),
});
export type TaskBranch = z.infer<typeof TaskBranch>;

const prStateLabel = { open: "open", draft: "draft", merged: "merged", closed: "closed" } as const;

/**
 * The task's branches from its links, ordered for the picker: branches of open PRs first, then other active ones,
 * newest link first, then those whose PRs merged or closed. A branch found several ways is listed once with each
 * source. Archived threads are skipped, and so are `exclude`d branches (the default branch and the epic's integration
 * branch, which are bases rather than the task's own work). `worktreePath` is left null for the caller to fill in.
 */
export function linkBranches(
  links: readonly TaskLink[],
  options: {
    /** The branch an agent session's folder has checked out, read by the caller (with git); null when unknown. */
    sessionBranch?: (link: Extract<TaskLink, { kind: "agent_session" }>) => string | null;
    exclude?: ReadonlyArray<string | null | undefined>;
  } = {},
): TaskBranch[] {
  const excluded = new Set(options.exclude?.filter((b): b is string => !!b).map(localName));
  type Found = { name: string; source: TaskBranchSource; open: boolean; at: string };
  const found: Found[] = [];
  for (const link of links) {
    if (link.kind === "pr") {
      const s = link.snapshot;
      if (!s?.headRef || s.isCrossRepository) continue;
      const number = link.ref?.number;
      const open = s.state === "open" || s.state === "draft";
      found.push({
        name: s.headRef,
        source: {
          kind: "pr",
          label: `${number ? `PR #${number}` : "PR"} ${prStateLabel[s.state]}`,
          inactive: !open,
        },
        open,
        at: link.createdAt,
      });
    } else if (link.kind === "t3_thread") {
      const branch = link.snapshot?.branch;
      if (!branch || link.snapshot?.archived) continue;
      found.push({
        name: branch,
        source: { kind: "t3_thread", label: "T3 thread", inactive: false },
        open: false,
        at: link.createdAt,
      });
    } else if (link.kind === "agent_session") {
      const branch = options.sessionBranch?.(link);
      if (!branch) continue;
      found.push({
        name: branch,
        source: { kind: "agent_session", label: `${AGENT_HARNESSES[link.ref.harness].label} session`, inactive: false },
        open: false,
        at: link.createdAt,
      });
    }
  }

  const byName = new Map<string, { sources: TaskBranchSource[]; open: boolean; at: string }>();
  // Newest first, so each branch's sources and its place among equals follow the newest link.
  for (const f of [...found].sort((a, b) => b.at.localeCompare(a.at))) {
    const name = localName(f.name);
    if (excluded.has(name)) continue;
    const entry = byName.get(name);
    if (!entry) {
      byName.set(name, { sources: [f.source], open: f.open, at: f.at });
      continue;
    }
    entry.open ||= f.open;
    if (!entry.sources.some((s) => s.label === f.source.label)) entry.sources.push(f.source);
  }

  const rank = (e: { sources: TaskBranchSource[]; open: boolean }) =>
    e.open ? 0 : e.sources.every((s) => s.inactive) ? 2 : 1;
  return [...byName.entries()]
    .map(([name, e], index) => ({ name, e, index }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.index - b.index)
    .map(({ name, e }) => ({
      name,
      // An open PR's chip first, then other active sources, then finished ones: the chip that says why the branch
      // matters now leads.
      sources: [...e.sources].sort((a, b) => sourceRank(a) - sourceRank(b)),
      worktreePath: null,
      inactive: e.sources.every((s) => s.inactive),
    }));
}

const sourceRank = (s: TaskBranchSource): number => (s.inactive ? 2 : s.kind === "pr" ? 0 : 1);

/** A branch name without a leading `origin/`. */
const localName = (branch: string): string => branch.replace(/^origin\//, "");
