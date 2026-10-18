import { pickMergeMethod, type MergeMethod, type TaskSummary } from "@repo/contracts";
import { headSeenSince, isPrLink, notMergeable, type PrLink } from "../autopilot/mergeGate.ts";
import { AppError } from "../errors.ts";
import type { Services } from "../services/types.ts";
import type { GithubIntegration } from "./github.ts";

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
 * merge_task_pr (docs/features/github-prs.md#merge_task_pr): merges a task's one open PR into the default branch, the
 * only way the board merges there without the user clicking. Only for a task the user flagged for auto-merge, and only
 * once the gate Autopilot's epic merges use (notMergeable) finds nothing in the way. GitHub's own guard then checks the
 * PR still targets the default branch and still has the head that was checked. The merge moves the task to Done.
 */
export async function mergeTaskPr(
  deps: { services: Services; github: Pick<GithubIntegration, "mergeIntoDefaultBranch"> },
  taskId: string,
  input: { method?: MergeMethod | undefined },
  actor: string,
): Promise<MergeTaskPrResult> {
  const { services, github } = deps;
  const task = services.tasks.summary(taskId);
  if (task.kind === "epic") throw refuse(task, "an epic has no pull request of its own");
  if (task.autoMerge !== true) {
    throw refuse(
      task,
      "auto-merge isn't on for this task. Only the user can allow it; leave the merge to them unless they say otherwise",
    );
  }
  if (task.integrationBranch) {
    throw refuse(
      task,
      `its epic delivers through ${task.integrationBranch}, and Autopilot merges its pull request there`,
    );
  }
  // Every PR not yet merged or closed, unpolled ones included, so a second open PR is never left behind.
  const unfinished = task.links.filter(
    (l): l is PrLink => isPrLink(l) && l.snapshot?.state !== "merged" && l.snapshot?.state !== "closed",
  );
  if (unfinished.length === 0) throw refuse(task, "it has no open pull request linked");
  if (unfinished.length > 1) {
    throw refuse(task, `it has ${unfinished.length} open pull requests linked; merge_task_pr only merges a lone one`);
  }
  const link = unfinished[0]!;
  const snapshot = link.snapshot;
  // Someone outside the repository controls a fork's head; the board merges none anywhere, least of all here.
  if (snapshot?.isCrossRepository === true) {
    throw refuse(
      task,
      `PR #${link.ref.number} comes from a fork; merge_task_pr only merges branches from the repository itself`,
    );
  }
  // The gate's base check is GitHub's here: mergeIntoDefaultBranch refuses any base but the default branch.
  const timing = { now: Date.now(), headSince: headSeenSince(link, services.links.prChanges([link.id]).get(link.id)) };
  const reason = notMergeable(
    services,
    task,
    link,
    snapshot?.baseRef ?? "",
    services.autopilot.runsForTask(task.id, 200),
    timing,
  );
  if (reason) throw refuse(task, reason);
  // notMergeable passed, so the snapshot is there with a head and a base.
  const { headOid, baseRef } = snapshot as { headOid: string; baseRef: string };
  if (snapshot?.reviewDecision === "review_required") throw refuse(task, "it still needs an approving review");
  if (snapshot?.canMerge === false) throw refuse(task, "the signed-in GitHub account can't merge it");
  const allowed = snapshot?.mergeMethods ?? [];
  if (input.method && allowed.length > 0 && !allowed.includes(input.method)) {
    throw refuse(task, `the repository doesn't allow ${input.method} merges (it allows ${allowed.join(", ")})`);
  }
  const method = input.method ?? pickMergeMethod(allowed, null) ?? "merge";

  await github.mergeIntoDefaultBranch(link, { base: baseRef, headOid, method });

  services.tasks.addNote(
    task.id,
    `Merged PR #${link.ref.number} into ${baseRef} (${method}) with merge_task_pr: auto-merge is on for this task`,
    actor,
  );
  // The refreshed snapshot normally moves it; a failed refresh mustn't leave a merged task in Review.
  if (services.tasks.summary(task.id).status !== "done") services.tasks.move(task.id, { status: "done" }, actor);
  return { task: services.tasks.summary(task.id), number: link.ref.number, url: link.url, base: baseRef, method };
}
