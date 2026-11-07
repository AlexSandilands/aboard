import { pickMergeMethod, type MergeMethod, type TaskSummary } from "@repo/contracts";
import { headSeenSince, isPrLink, notMergeable, type PrLink } from "../autopilot/mergeGate.ts";
import { AppError } from "../errors.ts";
import type { Services } from "../services/types.ts";
import type { GitHosts } from "./gitHosts.ts";
import { describeUnresolved, type PrMerges } from "./prMerge.ts";

export interface MergeTaskPrResult {
  task: TaskSummary;
  number: number;
  url: string;
  base: string;
  method: MergeMethod;
}

const refuse = (task: TaskSummary, why: string) =>
  new AppError("VALIDATION", `Didn't merge #${task.number}'s pull request: ${why}`);

/**
 * Where a task flagged for auto-merge stands, by the rules merge_task_pr and Merge ready PRs' Into main share:
 * - `ready`: its one open PR passes the gate (notMergeable) and nothing else is in the way;
 * - `wait`: something that passes by itself or by an agent's work (a review, checks, a conflict to fix);
 * - `yours`: something only the user can settle (an approving review GitHub requires, an account that can't merge,
 *   two open PRs, a fork). `link` is the PR it is about, when there is one.
 */
export type AutoMergeVerdict =
  | { kind: "ready"; link: PrLink; headOid: string; base: string }
  | { kind: "wait"; reason: string; link: PrLink | null }
  | { kind: "yours"; reason: string; link: PrLink | null };

/** The verdict's reason when the signed-in account can't merge; merge_task_pr names the host in its refusal. */
const CANT_MERGE = "the signed-in account can't merge it";

export function autoMergeVerdict(services: Services, task: TaskSummary, now: number): AutoMergeVerdict {
  if (task.kind === "epic") return { kind: "yours", reason: "an epic has no pull request of its own", link: null };
  if (task.autoMerge !== true) {
    return {
      kind: "yours",
      reason:
        "auto-merge isn't on for this task. Only the user can allow it; leave the merge to them unless they say otherwise",
      link: null,
    };
  }
  if (task.integrationBranch) {
    return {
      kind: "yours",
      reason: `its epic delivers through ${task.integrationBranch}, and Autopilot merges its pull request there`,
      link: null,
    };
  }
  // Every PR not yet merged or closed, unpolled ones included, so a second open PR is never left behind.
  const unfinished = task.links.filter(
    (l): l is PrLink => isPrLink(l) && l.snapshot?.state !== "merged" && l.snapshot?.state !== "closed",
  );
  if (unfinished.length === 0) return { kind: "wait", reason: "it has no open pull request linked", link: null };
  if (unfinished.length > 1) {
    return {
      kind: "yours",
      reason: `it has ${unfinished.length} open pull requests linked; only a lone one is merged into the default branch`,
      link: null,
    };
  }
  const link = unfinished[0]!;
  const snapshot = link.snapshot;
  // Someone outside the repository controls a fork's head; the board merges none anywhere, least of all here.
  if (snapshot?.isCrossRepository === true) {
    return {
      kind: "yours",
      reason: `PR #${link.ref.number} comes from a fork; only branches from the repository itself are merged into the default branch`,
      link,
    };
  }
  // The gate's base check is the host's here: mergeIntoDefaultBranch refuses any base but the default branch.
  const timing = { now, headSince: headSeenSince(link, services.links.prChanges([link.id]).get(link.id)) };
  const reason = notMergeable(
    services,
    task,
    link,
    snapshot?.baseRef ?? "",
    services.autopilot.runsForTask(task.id, 200),
    timing,
  );
  if (reason) return { kind: "wait", reason, link };
  // notMergeable passed, so the snapshot is there with a head and a base.
  const { headOid, baseRef } = snapshot as { headOid: string; baseRef: string };
  if (snapshot?.reviewDecision === "review_required") {
    const unresolved = snapshot.mergeState === "blocked" ? (snapshot.unresolvedThreads ?? 0) : 0;
    return {
      kind: "yours",
      reason:
        unresolved > 0
          ? `it still needs an approving review, and it has ${describeUnresolved(unresolved)} the repository may require resolved`
          : "it still needs an approving review",
      link,
    };
  }
  if (snapshot?.canMerge === false) {
    return { kind: "yours", reason: CANT_MERGE, link };
  }
  return { kind: "ready", link, headOid, base: baseRef };
}

/**
 * merge_task_pr (docs/features/github-prs.md#merge_task_pr), and Merge ready PRs' Into main
 * (autopilot/automations/mergeEpicPrs.ts): merges a task's one open PR into the default branch, the only way the board
 * merges there without the user clicking. Only for a task the user flagged for auto-merge, and only once
 * autoMergeVerdict says it is ready. The host's fresh read then checks the PR still targets the default branch and
 * still has the head that was checked (`expectedHeadOid` when the caller checked one earlier). The merge moves the
 * task to Done. `via` names the caller in the task's note.
 */
export async function mergeTaskPr(
  deps: { services: Services; merges: Pick<PrMerges, "mergeIntoDefaultBranch">; hosts: Pick<GitHosts, "resolve"> },
  taskId: string,
  input: { method?: MergeMethod | undefined; expectedHeadOid?: string; via?: string },
  actor: string,
): Promise<MergeTaskPrResult> {
  const { services, merges, hosts } = deps;
  const task = services.tasks.summary(taskId);
  const verdict = autoMergeVerdict(services, task, Date.now());
  if (verdict.kind !== "ready") {
    if (verdict.reason === CANT_MERGE && verdict.link) {
      const label = (await hosts.resolve(verdict.link.ref.host))?.definition.label ?? "git host";
      throw refuse(task, `the signed-in ${label} account can't merge it`);
    }
    throw refuse(task, verdict.reason);
  }
  const { link, headOid, base: baseRef } = verdict;
  if (input.expectedHeadOid && input.expectedHeadOid !== headOid) {
    throw refuse(task, `PR #${link.ref.number} moved on since it was checked`);
  }
  const allowed = link.snapshot?.mergeMethods ?? [];
  if (input.method && allowed.length > 0 && !allowed.includes(input.method)) {
    throw refuse(task, `the repository doesn't allow ${input.method} merges (it allows ${allowed.join(", ")})`);
  }
  const method = input.method ?? pickMergeMethod(allowed, null) ?? "merge";

  await merges.mergeIntoDefaultBranch(link, { base: baseRef, headOid, method });

  const via = input.via ?? "merge_task_pr";
  services.tasks.addNote(
    task.id,
    `Merged PR #${link.ref.number} into ${baseRef} (${method}) with ${via}: auto-merge is on for this task`,
    actor,
  );
  // The refreshed snapshot normally moves it; a failed refresh mustn't leave a merged task in Review.
  if (services.tasks.summary(task.id).status !== "done") services.tasks.move(task.id, { status: "done" }, actor);
  return { task: services.tasks.summary(task.id), number: link.ref.number, url: link.url, base: baseRef, method };
}
