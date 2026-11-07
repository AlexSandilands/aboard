import { EPIC_BRANCH_PREFIX, type MergeMethod, type MergePrInput, type TaskLink } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { TasksService } from "../services/types.ts";
import type { DefaultBranchMergeInput, EpicMergeInput, GitHost } from "./gitHost.ts";
import type { GitHosts } from "./gitHosts.ts";
import { messageOf } from "./util.ts";

// The board's merges, on any git host: the panel's merge button, Autopilot's merges into an epic's branch and
// merge_task_pr's into the default branch. The guards here are the board's own; the host only reads and merges.

/** Autopilot was about to merge where it never may. Nothing was merged. */
export class MergeTargetError extends AppError {
  constructor(message: string) {
    super("VALIDATION", message);
    this.name = "MergeTargetError";
  }
}

/**
 * The guard on every merge the board makes on its own (docs/decisions/0008-autopilot-engine.md): only into the branch
 * it was asked for. Autopilot's merges (`into: "epic"`, the default) must go into an epic's integration branch and
 * never into the default branch. merge_task_pr, for a task the user flagged for auto-merge, is the one path that
 * merges into the default branch (`into: "default"`), and only there. Checked against what the host says just before
 * the merge, so a PR retargeted since the last poll is caught.
 */
export function checkAutopilotMergeTarget(target: {
  base: string;
  expectedBase: string;
  defaultBranch: string | null;
  into?: "epic" | "default";
}): void {
  if (target.defaultBranch === null) {
    throw new MergeTargetError("Can't tell the repository's default branch, so the board won't merge");
  }
  if (target.into === "default") {
    if (target.expectedBase !== target.defaultBranch) {
      throw new MergeTargetError(
        `The PR targets ${target.expectedBase}, not the default branch (${target.defaultBranch}): merge_task_pr only merges into the default branch`,
      );
    }
    if (target.base !== target.expectedBase) {
      throw new MergeTargetError(`The PR now merges into ${target.base}, not ${target.expectedBase}`);
    }
    return;
  }
  if (target.base === target.defaultBranch || target.expectedBase === target.defaultBranch) {
    throw new MergeTargetError(`Autopilot never merges into the default branch (${target.defaultBranch})`);
  }
  if (!target.expectedBase.startsWith(EPIC_BRANCH_PREFIX)) {
    throw new MergeTargetError(`Autopilot only merges into an epic's integration branch, not ${target.expectedBase}`);
  }
  if (target.base !== target.expectedBase) {
    throw new MergeTargetError(`The PR now merges into ${target.base}, not the epic's branch ${target.expectedBase}`);
  }
}

/**
 * The methods to try for a merge into an epic's branch, best first: a merge commit keeps each task's commits, so it
 * is used wherever the repository allows it; a repository that doesn't gets a squash, then a rebase.
 */
export function epicMergeMethods(allowed: readonly MergeMethod[]): MergeMethod[] {
  return (["merge", "squash", "rebase"] as const).filter((m) => allowed.includes(m));
}

/** "3 unresolved review conversations". */
export const describeUnresolved = (count: number): string =>
  `${count} unresolved review conversation${count === 1 ? "" : "s"}`;

/** Merge states in which the host merges at once rather than waiting, as `gh pr merge --auto` treats them. */
const IMMEDIATELY_MERGEABLE = new Set(["clean", "has_hooks", "unstable"]);

type PrLink = Extract<TaskLink, { kind: "pr" }>;
type RefPrLink = PrLink & { ref: NonNullable<PrLink["ref"]> };

export interface PrMerges {
  /** Merges a Review task's PR, or turns auto-merge on or off, then refreshes it. Throws AppError. */
  merge(link: TaskLink, input: MergePrInput): Promise<void>;
  /**
   * Autopilot's merge of a task's PR into its epic's integration branch, at `headOid`, once checkAutopilotMergeTarget
   * passes on what the host says now. Then refreshes the link, which moves the task to Done. Throws MergeTargetError
   * for a target it may never merge into, AppError for anything else the host refuses.
   */
  mergeIntoEpicBranch(link: TaskLink, input: EpicMergeInput): Promise<{ method: MergeMethod }>;
  /**
   * merge_task_pr's merge of a task's PR into the default branch, at `headOid`, once checkAutopilotMergeTarget (into
   * "default") passes on what the host says now. Then refreshes the link. Throws MergeTargetError for any other base,
   * AppError for anything else the host refuses.
   */
  mergeIntoDefaultBranch(link: TaskLink, input: DefaultBranchMergeInput): Promise<void>;
}

export function createPrMerges(deps: {
  hosts: GitHosts;
  tasks: () => Pick<TasksService, "summary">;
  /** Reads the link again and stores it; logs rather than throws when `quiet`. */
  refresh(link: RefPrLink, opts?: { quiet?: boolean }): Promise<void>;
}): PrMerges {
  const { hosts } = deps;
  /** "GitHub", or each kind's name when there are several. */
  const kindLabels = () =>
    hosts
      .all()
      .map((h) => h.definition.label)
      .join(" or ");

  /** The host serving a PR link, signed in, or why it can't be merged. */
  const hostOf = async (link: RefPrLink, notHosted: () => AppError): Promise<GitHost> => {
    const host = await hosts.resolve(link.ref.host);
    if (!host) throw notHosted();
    await host.requireSignedIn(link.ref.host);
    return host;
  };

  /** Shows the new head (or whatever the host now says) before reporting why it failed, as an AppError. */
  const failed = async (link: RefPrLink, error: unknown): Promise<never> => {
    await deps.refresh(link).catch(() => {});
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION", messageOf(error));
  };

  /**
   * A board-made merge at the checked head, once checkAutopilotMergeTarget passes on what the host says now. With
   * `method` it merges that way; without, it takes the repository's allowed methods as the host says now
   * (epicMergeMethods) and moves to the next when the host refuses one as not allowed. Returns the method that merged.
   */
  const mergeChecked = async (
    link: TaskLink,
    input: { into: "epic" | "default"; base: string; headOid: string; method?: MergeMethod },
  ): Promise<{ method: MergeMethod }> => {
    const notHosted = () => new AppError("VALIDATION", `Only a ${kindLabels()} pull request can be merged`);
    if (link.kind !== "pr" || !link.ref) throw notHosted();
    const pr = link as RefPrLink;
    const host = await hostOf(pr, notHosted);
    const label = host.definition.label;
    let merged: MergeMethod;
    try {
      const target = await host.mergeTarget(pr.ref);
      checkAutopilotMergeTarget({
        base: target.base,
        expectedBase: input.base,
        defaultBranch: target.defaultBranch,
        into: input.into,
      });
      if (target.state !== "open") throw new AppError("CONFLICT", `The PR is ${target.state}`);
      if (target.headOid !== input.headOid) {
        throw new AppError("CONFLICT", `The PR moved on to ${target.headOid.slice(0, 7)} since it was checked`);
      }
      // An admin's account may merge past branch rules (a required approval, an out-of-date branch); into the
      // default branch the board only merges what the host would let anyone merge.
      const state = target.mergeState ?? "unknown";
      if (input.into === "default" && !IMMEDIATELY_MERGEABLE.has(state)) {
        const unresolved = pr.snapshot?.unresolvedThreads ?? 0;
        const shown = state.toUpperCase();
        throw new AppError(
          "VALIDATION",
          state === "unknown"
            ? `${label} is still working out whether the PR can be merged: try again in a minute`
            : state === "blocked" && unresolved > 0
              ? `${label} says the PR can't be merged yet (${shown}): it has ${describeUnresolved(unresolved)}, and the repository may require them resolved, or a branch rule such as a required approval isn't met`
              : `${label} says the PR can't be merged yet (${shown}): a branch rule such as a required approval or an up-to-date branch isn't met`,
        );
      }
      const methods = input.method ? [input.method] : epicMergeMethods(target.mergeMethods);
      if (methods.length === 0) {
        throw new AppError("VALIDATION", "The repository allows no merge method (merge commit, squash or rebase)");
      }
      merged = await host.mergeAt(pr.ref, target, methods);
    } catch (error) {
      // Show the new head, or the PR merged or closed by hand, so the next check doesn't try the old head again.
      return failed(pr, error);
    }
    await deps.refresh(pr, { quiet: true });
    return { method: merged };
  };

  return {
    async merge(link, input) {
      const notHosted = () => new AppError("VALIDATION", `Only ${kindLabels()} pull requests can be merged from here`);
      // Everything that needs no host comes first, so a refusal never spawns its CLI.
      if (link.kind !== "pr" || !link.ref) throw notHosted();
      const pr = link as RefPrLink;
      const task = deps.tasks().summary(link.taskId);
      if (task.status !== "review") throw new AppError("VALIDATION", "Only a task in Review can merge its PR");
      const snapshot = link.snapshot;
      if (!snapshot) throw new AppError("VALIDATION", "Refresh the PR before merging it");
      if (!snapshot.canMerge) {
        const label = hosts.forHost(link.ref.host)?.definition.label ?? kindLabels();
        throw new AppError("VALIDATION", `The signed-in ${label} account can't merge this PR`);
      }
      if (input.action !== "disable_auto" && !snapshot.mergeMethods?.includes(input.method!)) {
        throw new AppError("VALIDATION", `This repository doesn't allow ${input.method} merges`);
      }
      const host = await hostOf(pr, notHosted);
      try {
        await host.merge(pr.ref, { ...input, expectedHeadOid: snapshot.headOid ?? null });
      } catch (error) {
        return failed(pr, error);
      }
      await deps.refresh(pr, { quiet: true });
    },
    mergeIntoEpicBranch(link, input) {
      // A merge commit where the repository allows one, so the epic's branch keeps each task's commits; else the
      // method its settings do allow.
      return mergeChecked(link, { into: "epic", base: input.base, headOid: input.headOid });
    },
    async mergeIntoDefaultBranch(link, input) {
      await mergeChecked(link, { into: "default", base: input.base, headOid: input.headOid, method: input.method });
    },
  };
}
