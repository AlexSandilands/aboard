import { AUTOPILOT_MERGE_EPIC_PRS, type AutopilotRun, type TaskSummary } from "@repo/contracts";
import { createHash } from "node:crypto";
import { AppError } from "../../errors.ts";
import { isTransientHostError } from "../../integrations/gitHost.ts";
import type { GitHostActions } from "../../integrations/gitHosts.ts";
import { autoMergeVerdict } from "../../integrations/mergeTaskPr.ts";
import { MergeTargetError } from "../../integrations/prMerge.ts";
import { messageOf } from "../../integrations/util.ts";
import type { Services } from "../../services/types.ts";
import { isPrLink, type PrLink } from "../mergeGate.ts";
import type { ActionResult, Candidate } from "../types.ts";

// Merge ready PRs' Into main (docs/features/autopilot.md#merge-ready-prs): a task the user flagged for auto-merge has
// its one open PR merged into the default branch once merge_task_pr's own rules (autoMergeVerdict) say it's ready, one
// PR at a time per repository, and only once every other candidate there has been read again since the last merge.

export interface MainMergeData {
  kind: "main_merge";
  linkId: string;
  headOid: string;
  base: string;
  number: number;
  /** Which try at this head this is, from 1. */
  attempt: number;
}

export interface MainHoldData {
  kind: "main_hold";
  reason: string;
}

/** Tries per PR head when a merge fails for a reason that may pass, before asking the user. */
export const MAIN_MERGE_ATTEMPTS = 3;

/** A merge the host refused for now: a race with another merge or a push, or GitHub still working mergeability out. */
const PASSING = /base branch was modified|head branch was modified|try again in a minute/i;

/** On a skipped merge run: it settled nothing, so the head may be tried again. */
const RETRY = { retry: true };
/** A skip from the re-check before the merge: nothing was tried, so it doesn't count as a try. */
const RECHECK = { retry: true, recheck: true };

const hashOf = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

const repoOf = (link: PrLink) => `${link.ref.host}/${link.ref.repo}`;

/** Earlier Into main runs at this PR head; a retry only follows ones that ended without settling anything. */
function mainRuns(runs: readonly AutopilotRun[], linkId: string, headOid: string) {
  const key = `main:${linkId}:${headOid}`;
  const ofHead = runs.filter(
    (r) =>
      r.automation === AUTOPILOT_MERGE_EPIC_PRS &&
      !r.dryRun &&
      (r.dedupeKey === key || r.dedupeKey.startsWith(`${key}:`)),
  );
  return {
    key,
    runs: ofHead.length,
    count: ofHead.filter((r) => r.output?.recheck !== true).length,
    settled: ofHead.some((r) => !(r.status === "skipped" && r.output?.retry === true)),
  };
}

/** The tasks Into main looks at in a project: open tasks in Review flagged for auto-merge, not delivered through an epic's branch. */
const flagged = (tasks: readonly TaskSummary[]) =>
  tasks.filter(
    (t) =>
      t.kind !== "epic" &&
      t.archivedAt === null &&
      t.status === "review" &&
      t.autoMerge === true &&
      !t.integrationBranch,
  );

/**
 * Into main's candidates in one project: at most one merge per repository (the first ready PR, a task before those it
 * blocks, then by number), none in a repository where one is already queued or running, and none for a PR the board
 * hasn't read since the latest merge into its base there (that merge may have left it conflicting). A flagged task held
 * by something only the user can settle (a required approval, two open PRs) gets one notice per PR head and reason.
 */
export function mainCandidates(services: Services, tasks: readonly TaskSummary[], now: Date): Candidate[] {
  const all = flagged(tasks);
  if (all.length === 0) return [];
  const active = services.autopilot
    .status()
    .active.filter((r) => r.automation === AUTOPILOT_MERGE_EPIC_PRS && r.taskId !== null);
  const busy = new Set<string>();
  for (const run of active) {
    const task = tasks.find((t) => t.id === run.taskId);
    if (!task || task.integrationBranch) continue;
    for (const link of task.links.filter(isPrLink)) busy.add(repoOf(link));
  }

  // When each base last moved by a merge the board saw, per repository: from every merged PR link in the project.
  const merged = tasks.flatMap((t) =>
    t.links.filter((l): l is PrLink => isPrLink(l) && l.snapshot?.state === "merged"),
  );
  const changes = services.links.prChanges(merged.map((l) => l.id));
  const lastMerge = new Map<string, number>();
  for (const link of merged) {
    const at = Date.parse(changes.get(link.id)?.merged ?? link.syncedAt ?? link.createdAt);
    const key = `${repoOf(link)}#${link.snapshot?.baseRef ?? ""}`;
    if (!(at <= (lastMerge.get(key) ?? -Infinity))) lastMerge.set(key, at);
  }

  const ids = new Set(all.map((t) => t.id));
  // A task blocked by another flagged task goes after it, so a change lands before the ones that build on it.
  const ordered = all
    .slice()
    .sort(
      (a, b) =>
        Number(a.blockedBy.some((r) => ids.has(r.id))) - Number(b.blockedBy.some((r) => ids.has(r.id))) ||
        a.number - b.number,
    );

  const taken = new Set<string>();
  const out: Candidate[] = [];
  for (const task of ordered) {
    const verdict = autoMergeVerdict(services, task, now.getTime());
    if (verdict.kind === "wait") continue;
    if (verdict.kind === "yours") {
      const head = verdict.link?.snapshot?.headOid ?? "none";
      const data: MainHoldData = { kind: "main_hold", reason: verdict.reason };
      out.push({
        dedupeKey: `main-hold:${verdict.link?.id ?? task.id}:${head}:${hashOf(verdict.reason)}`,
        summary: `say why #${task.number} can't merge into main by itself`,
        taskId: task.id,
        data,
      });
      continue;
    }
    const { link, headOid, base } = verdict;
    const repo = repoOf(link);
    if (busy.has(repo) || taken.has(repo)) continue;
    const since = lastMerge.get(`${repo}#${base}`);
    if (since !== undefined && !(Date.parse(link.syncedAt ?? "") > since)) continue;
    const earlier = mainRuns(services.autopilot.runsForTask(task.id, 200), link.id, headOid);
    if (earlier.settled || earlier.count >= MAIN_MERGE_ATTEMPTS) continue;
    taken.add(repo);
    const data: MainMergeData = {
      kind: "main_merge",
      linkId: link.id,
      headOid,
      base,
      number: link.ref.number,
      attempt: earlier.count + 1,
    };
    out.push({
      dedupeKey: earlier.runs === 0 ? earlier.key : `${earlier.key}:${earlier.runs + 1}`,
      summary: `merge PR #${link.ref.number} of #${task.number} into ${base}`,
      taskId: task.id,
      data,
    });
  }
  return out;
}

/** The notice for a flagged task only the user can unblock: flagged on the task, nothing tried. */
export function holdAction(task: TaskSummary, data: MainHoldData): ActionResult {
  return {
    status: "skipped",
    summary: `Ready to merge into main, but Autopilot won't merge #${task.number} by itself: ${data.reason}. Merge it yourself, or fix that.`,
    needsAttention: true,
  };
}

/**
 * Merges a flagged task's PR into the default branch through merge_task_pr's path (gitHosts.mergeAutoMergeTask), after
 * checking again that it is still ready at the head the check saw. Then reads the repository's other flagged PRs again,
 * so the next merge there waits for their state after this one.
 */
export async function mainMergeAction(
  services: Services,
  gitHosts: GitHostActions,
  taskId: string,
  data: MainMergeData,
  actor: string,
): Promise<ActionResult> {
  const task = services.tasks.summary(taskId);
  const verdict = autoMergeVerdict(services, task, Date.now());
  if (verdict.kind !== "ready") {
    return { status: "skipped", summary: `Didn't merge PR #${data.number}: ${verdict.reason}`, output: RECHECK };
  }
  if (verdict.link.id !== data.linkId || verdict.headOid !== data.headOid) {
    return { status: "skipped", summary: `PR #${data.number} moved on before the merge`, output: RECHECK };
  }
  let method: string;
  try {
    ({ method } = await gitHosts.mergeAutoMergeTask(
      task.id,
      { expectedHeadOid: data.headOid, via: "Autopilot's Merge ready PRs" },
      actor,
    ));
  } catch (error) {
    if (error instanceof MergeTargetError) {
      return {
        status: "failed",
        error: `Autopilot refused to merge PR #${data.number}: ${error.message}`,
        needsAttention: true,
      };
    }
    const message = messageOf(error);
    // The task's own refusal: something changed between the re-check and the merge. The next pass looks again.
    if (error instanceof AppError && message.startsWith("Didn't merge")) {
      return { status: "skipped", summary: message, output: RECHECK };
    }
    const passing =
      (error instanceof AppError && error.code === "CONFLICT") || PASSING.test(message) || isTransientHostError(error);
    if (passing && data.attempt < MAIN_MERGE_ATTEMPTS) {
      return {
        status: "skipped",
        summary: `Couldn't merge PR #${data.number} yet (try ${data.attempt} of ${MAIN_MERGE_ATTEMPTS}): ${message}`,
        output: RETRY,
      };
    }
    return {
      status: "skipped",
      summary: `Ready to merge into main: the git host didn't let Autopilot merge PR #${data.number} into ${data.base} (${message}). Merge it yourself.`,
      needsAttention: true,
    };
  }
  // The others' mergeability and checks may have changed with the base: read them now, not at the next poll.
  const repo = repoOf(verdict.link);
  const others = flagged(services.tasks.summaries({ projectId: task.projectId }))
    .flatMap((t) => t.links.filter(isPrLink))
    .filter((l) => l.id !== verdict.link.id && repoOf(l) === repo && l.snapshot?.state === "open");
  for (const link of others) await gitHosts.rereadPr(link);
  return { summary: `Merged PR #${data.number} into ${data.base} (${method})`, output: { into: "main" } };
}
