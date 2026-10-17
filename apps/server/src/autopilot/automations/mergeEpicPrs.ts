import { createHash } from "node:crypto";
import {
  AUTOPILOT_ACTIVE_STATUSES,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_MERGE_EPIC_PRS,
  AUTOPILOT_REVIEW_PRS,
  BRAND,
  currentPrReview,
  describeCounts,
  prReviewOutput,
  reviewIsInProgress,
  TASK_STATUSES,
  type AutopilotRun,
  type PrChanges,
  type PrRef,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { MergeTargetError, messageOf } from "../../integrations/github.ts";
import type { Services } from "../../services/types.ts";
import { defineAutomation, type ActionResult, type Candidate } from "../types.ts";

export { AUTOPILOT_MERGE_EPIC_PRS };

type PrLink = Extract<TaskLink, { kind: "pr" }> & { ref: PrRef };

interface MergeData {
  kind: "merge";
  linkId: string;
  headOid: string;
  branch: string;
  number: number;
  /** Which try at this head this is, from 1. */
  attempt: number;
}

/** Tries per PR head when a merge fails for a reason that may pass (a race, a network error), before asking the user. */
export const MERGE_ATTEMPTS = 3;

/**
 * How long a head must have gone without any check reporting before "no checks" counts as green. GitHub reports none
 * for the first moments after a push, before the workflows register.
 */
export const NO_CHECKS_WAIT_MS = 10 * 60_000;

/** When the board first saw the PR at its current head: the head's move, else the link's creation. */
const headSeenSince = (link: PrLink, changes: PrChanges | undefined): number =>
  Date.parse(changes?.newHead ?? link.createdAt);

/** Earlier merge runs of this PR head; a retry only follows ones that ended without settling anything. */
function mergeRuns(runs: readonly AutopilotRun[], linkId: string, headOid: string) {
  const key = `merge:${linkId}:${headOid}`;
  const ofHead = runs.filter(
    (r) =>
      r.automation === AUTOPILOT_MERGE_EPIC_PRS &&
      !r.dryRun &&
      (r.dedupeKey === key || r.dedupeKey.startsWith(`${key}:`)),
  );
  return {
    key,
    runs: ofHead.length,
    // Tries that reached GitHub; a re-check that found a reason to wait doesn't use one up.
    count: ofHead.filter((r) => r.output?.recheck !== true).length,
    // Running, merged, flagged or refused: nothing more to try at this head.
    settled: ofHead.some((r) => !(r.status === "skipped" && r.output?.retry === true)),
  };
}

/**
 * Failures another try may get past: a race with another merge into the branch or a push, GitHub still working out
 * mergeability, the network. Anything else (branch rules wanting an approval, permissions) goes to the user at once.
 */
const PASSING_FAILURE =
  /base branch was modified|head branch was modified|not mergeable|try again|timed? ?out|econn|fetch failed|socket|rate limit|unavailable|\b5\d\d\b/i;

interface EpicPrData {
  kind: "open_pr" | "update_pr";
  branch: string;
  host: string;
  repo: string;
  /** The epic's PR link, when it has one (update). */
  linkId: string | null;
  body: string;
}

/** On a skipped merge run: it settled nothing, so the head may be tried again. */
const RETRY = { retry: true };
/** A skip from the re-check before the merge: nothing was tried, so it doesn't count as a try. */
const RECHECK = { retry: true, recheck: true };

const isPrLink = (link: TaskLink): link is PrLink => link.kind === "pr" && link.ref !== null;

/** The task's PRs that go into the branch: polled, from origin (not a fork), with the branch as their base. */
const prsInto = (task: TaskSummary, branch: string): PrLink[] =>
  task.links.filter(
    (l): l is PrLink => isPrLink(l) && l.snapshot?.baseRef === branch && l.snapshot.isCrossRepository !== true,
  );

const reviewPrsOn = (services: Services, task: TaskSummary): boolean => {
  const automation = services.autopilot.automations().find((a) => a.key === AUTOPILOT_REVIEW_PRS);
  return (
    automation !== undefined && services.autopilot.resolve(automation, task.projectId, task.parent?.id ?? null).enabled
  );
};

/**
 * Why a task's PR can't be merged into its epic's branch yet, or null when it can. The same rules decide the candidates
 * and re-check them before the merge:
 * - the task is In Review and its PR is open (not a draft), into the branch, at `headOid`;
 * - its local review loop is over: no round pending, running or stalled, no blocking or major finding open;
 * - Review PRs, when it is on for the task, reviewed this head and found nothing at or above the fix threshold;
 * - no review or fix of the task's PRs is running, and no reviewer requested changes on GitHub;
 * - its checks pass, or none has reported for NO_CHECKS_WAIT_MS since the head was first seen (GitHub reports none
 *   for a moment after a push), and GitHub says it merges cleanly.
 */
export function notMergeable(
  services: Services,
  task: TaskSummary,
  link: PrLink,
  branch: string,
  runs: readonly AutopilotRun[],
  timing: { now: number; headSince: number },
): string | null {
  const snapshot = link.snapshot;
  if (task.kind === "epic" || task.archivedAt !== null) return "it isn't an open task";
  if (task.status !== "review") return "it isn't in Review";
  if (!snapshot || snapshot.state !== "open") return `PR #${link.ref.number} isn't open and ready for review`;
  if (snapshot.baseRef !== branch) return `PR #${link.ref.number} doesn't target ${branch}`;
  if (!snapshot.headOid) return `PR #${link.ref.number} has no head commit yet`;
  if (task.review) {
    if (reviewIsInProgress(task.review, services.reviews.effectiveAutoReview(task.id))) {
      return "its local review is still going";
    }
    if (task.review.open.blocking + task.review.open.major > 0) {
      return "its local review left blocking or major findings open";
    }
  }
  const active = runs.filter(
    (r) =>
      !r.dryRun &&
      AUTOPILOT_ACTIVE_STATUSES.includes(r.status) &&
      (r.automation === AUTOPILOT_REVIEW_PRS || r.automation === AUTOPILOT_FIX_PRS),
  );
  if (active.length > 0) return "a review or fix of its PR is running";
  if (reviewPrsOn(services, task)) {
    const verdict = currentPrReview(runs, link.id, snapshot.headOid);
    if (!verdict) return `Review PRs hasn't reviewed PR #${link.ref.number} at its head yet`;
    if (verdict.actionable > 0)
      return `Review PRs found ${verdict.actionable} point(s) at or above ${verdict.threshold}`;
  }
  if (snapshot.reviewDecision === "changes_requested") return `a reviewer requested changes on PR #${link.ref.number}`;
  if (snapshot.checks !== "passing" && snapshot.checks !== "none") return `its checks are ${snapshot.checks}`;
  if (snapshot.checks === "none" && !(timing.now - timing.headSince >= NO_CHECKS_WAIT_MS)) {
    return `no checks have reported on PR #${link.ref.number} yet`;
  }
  if (snapshot.mergeable !== "mergeable") {
    return snapshot.mergeable === "conflicting"
      ? `PR #${link.ref.number} conflicts with ${branch}`
      : "GitHub hasn't said it merges cleanly yet";
  }
  return null;
}

const STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<
  TaskSummary["status"],
  string
>;

const RESOLUTION: Record<NonNullable<TaskSummary["resolution"]>, string> = {
  completed: "closed as done elsewhere",
  duplicate: "closed as a duplicate",
  wont_do: "closed as won't do",
};

/** One task's line: its state, its PRs into the branch and what their reviews said. */
function taskLine(task: TaskSummary, branch: string, runs: readonly AutopilotRun[]): string {
  const done = task.status === "done";
  const state = task.resolution ? RESOLUTION[task.resolution] : STATUS_LABEL[task.status];
  const parts = [`#${task.number} ${task.title.replace(/\s+/g, " ")}`, state];
  for (const link of prsInto(task, branch)) {
    const reviews = runs.flatMap((r) => {
      const out = prReviewOutput(r);
      return out && out.linkId === link.id ? [out] : [];
    });
    const latest = reviews.reduce<(typeof reviews)[number] | null>((a, b) => (a && a.round > b.round ? a : b), null);
    const review = latest ? `, Autopilot review round ${latest.round}: ${describeCounts(latest.counts)}` : "";
    parts.push(`[PR #${link.ref.number}](${link.url}) ${link.snapshot?.state ?? "not polled"}${review}`);
  }
  if (task.review) {
    const open = task.review.open.blocking + task.review.open.major;
    parts.push(
      `local review ${task.review.state} after ${task.review.round} round(s)${open > 0 ? `, ${open} blocking/major open` : ""}`,
    );
  }
  return `- [${done ? "x" : " "}] ${parts.join(" · ")}`;
}

/**
 * The epic PR's description: what the epic is, how it is delivered, and every task with its PR and reviews. It holds
 * no times, so it only changes when something in it does (its hash is in the update's dedupe key).
 */
export function epicPrBody(
  epic: TaskSummary,
  children: readonly TaskSummary[],
  runsOf: (taskId: string) => readonly AutopilotRun[],
): string {
  const branch = epic.integrationBranch ?? "";
  const counted = children.filter((c) => c.archivedAt === null);
  const done = counted.filter((c) => c.status === "done").length;
  return [
    `Epic #${epic.number} "${epic.title}", delivered through the integration branch \`${branch}\`.`,
    "",
    `🤖 ${BRAND.name} Autopilot merges each task's pull request into \`${branch}\` once its reviews are finished and its checks pass, and keeps this description current. It never merges this pull request: that is yours, once you're happy with the whole epic.`,
    "",
    `## Tasks (${done} of ${counted.length} done)`,
    "",
    ...counted
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((c) => taskLine(c, branch, runsOf(c.id))),
  ].join("\n");
}

const hashOf = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

/** The epic's own PR from its branch: one whose head is the branch, or (before its first poll) any PR linked on it. */
const epicPrLink = (epic: TaskSummary, branch: string): PrLink | "unpolled" | null => {
  const prs = epic.links.filter(isPrLink);
  const own = prs.find((l) => l.snapshot?.headRef === branch);
  if (own) return own;
  return prs.some((l) => !l.snapshot) ? "unpolled" : null;
};

/**
 * Merge into epic branch (docs/features/autopilot.md#merge-into-epic-branch). For each epic delivered through an
 * integration branch:
 * - merges a task's PR into the branch, with a merge commit, once `notMergeable` finds nothing in the way. Once per PR
 *   and head commit. GitHub refusing (branch rules wanting an approval) puts "Ready to merge into the epic branch" on
 *   the task and notifies. The merge moves the task to Done, which unblocks what waits on it.
 * - opens a draft PR from the branch into the default branch once a task has merged, links it on the epic, and keeps
 *   its description listing the tasks. It never merges that PR, nor anything into the default branch.
 */
export const mergeEpicPrs = defineAutomation({
  key: AUTOPILOT_MERGE_EPIC_PRS,
  title: "Merge into epic branch",
  description:
    "For epics delivered through an integration branch: merges each task's PR into the epic's branch once it's reviewed and green, and keeps the epic's draft PR to main. Never merges into main.",
  needsAgent: false,
  schema: z.object({}),
  fields: [],
  defaults: {},
  check: ({ services, projects, now }) =>
    projects.flatMap(({ project }): Candidate[] => {
      const tasks = services.tasks.summaries({ projectId: project.id });
      return tasks.flatMap((epic): Candidate[] => {
        const branch = epic.kind === "epic" ? epic.integrationBranch : null;
        if (!branch || epic.archivedAt !== null) return [];
        const children = tasks.filter((t) => t.parent?.id === epic.id);
        const runs = new Map(children.map((c) => [c.id, services.autopilot.runsForTask(c.id, 200)]));
        const runsOf = (id: string) => runs.get(id) ?? [];
        const changes = services.links.prChanges(children.flatMap((c) => prsInto(c, branch).map((l) => l.id)));

        const merges = children.flatMap((task) =>
          prsInto(task, branch).flatMap((link): Candidate[] => {
            const timing = { now: now.getTime(), headSince: headSeenSince(link, changes.get(link.id)) };
            if (notMergeable(services, task, link, branch, runsOf(task.id), timing) !== null) return [];
            const earlier = mergeRuns(runsOf(task.id), link.id, link.snapshot!.headOid!);
            if (earlier.settled || earlier.count >= MERGE_ATTEMPTS) return [];
            const data: MergeData = {
              kind: "merge",
              linkId: link.id,
              headOid: link.snapshot!.headOid!,
              branch,
              number: link.ref.number,
              attempt: earlier.count + 1,
            };
            return [
              {
                dedupeKey: earlier.runs === 0 ? earlier.key : `${earlier.key}:${earlier.runs + 1}`,
                summary: `merge PR #${link.ref.number} of #${task.number} into ${branch}`,
                taskId: task.id,
                data,
              },
            ];
          }),
        );

        // The epic's PR waits for something to collect: the first task merged into the branch.
        const merged = children.flatMap((c) => prsInto(c, branch).filter((l) => l.snapshot?.state === "merged"));
        const first = merged[0];
        if (!first) return merges;
        const own = epicPrLink(epic, branch);
        if (own === "unpolled") return merges;
        if (own && own.snapshot?.state !== "open" && own.snapshot?.state !== "draft") return merges;
        const body = epicPrBody(epic, children, runsOf);
        const data: EpicPrData = {
          kind: own ? "update_pr" : "open_pr",
          branch,
          host: first.ref.host,
          repo: first.ref.repo,
          linkId: own ? own.id : null,
          body,
        };
        const upkeep: Candidate = own
          ? {
              dedupeKey: `epic-pr-body:${own.id}:${hashOf(body)}`,
              summary: `update the description of epic #${epic.number}'s PR #${own.ref.number}`,
              taskId: epic.id,
              data,
            }
          : {
              // With the merged count, so a failed attempt is tried again after the next merge.
              dedupeKey: `epic-pr:${epic.id}:${branch}:${merged.length}`,
              summary: `open a draft PR from ${branch} for epic #${epic.number}`,
              taskId: epic.id,
              data,
            };
        return [...merges, upkeep];
      });
    }),
  act: async (candidate, { services, github, actor }): Promise<ActionResult> => {
    const data = candidate.data as MergeData | EpicPrData;
    if (data.kind === "merge") {
      const task = services.tasks.summary(candidate.taskId!);
      const link = task.links.find((l): l is PrLink => l.id === data.linkId && isPrLink(l));
      if (!link) return { status: "skipped", summary: "The PR link was removed" };
      // Re-checked on the latest state: a push, a new finding or the epic switching back since the check.
      if (task.integrationBranch !== data.branch) {
        return { status: "skipped", summary: `#${task.number}'s epic no longer delivers through ${data.branch}` };
      }
      if (link.snapshot?.headOid !== data.headOid) {
        return { status: "skipped", summary: `PR #${data.number} moved on before the merge` };
      }
      const timing = {
        now: Date.now(),
        headSince: headSeenSince(link, services.links.prChanges([link.id]).get(link.id)),
      };
      const runs = services.autopilot.runsForTask(task.id, 200);
      const reason = notMergeable(services, task, link, data.branch, runs, timing);
      // Something changed since the check; the next pass looks again.
      if (reason) return { status: "skipped", summary: `Didn't merge PR #${data.number}: ${reason}`, output: RECHECK };
      try {
        await github.mergeIntoEpicBranch(link, { base: data.branch, headOid: data.headOid });
      } catch (error) {
        if (error instanceof MergeTargetError) {
          return {
            status: "failed",
            error: `Autopilot refused to merge PR #${data.number}: ${error.message}`,
            needsAttention: true,
          };
        }
        const message = messageOf(error);
        // A race (another PR just merged into the branch, a push) or a network error may pass: try again next pass.
        const passing = (error instanceof AppError && error.code === "CONFLICT") || PASSING_FAILURE.test(message);
        if (passing && data.attempt < MERGE_ATTEMPTS) {
          return {
            status: "skipped",
            summary: `Couldn't merge PR #${data.number} yet (try ${data.attempt} of ${MERGE_ATTEMPTS}): ${message}`,
            output: RETRY,
          };
        }
        // Branch rules wanting an approval, or tries used up: the user can still merge it by hand.
        return {
          status: "skipped",
          summary: `Ready to merge into the epic branch: GitHub didn't let Autopilot merge PR #${data.number} into ${data.branch} (${message}). Merge it yourself.`,
          needsAttention: true,
        };
      }
      return { summary: `Merged PR #${data.number} into ${data.branch}` };
    }

    const epic = services.tasks.summary(candidate.taskId!);
    if (epic.integrationBranch !== data.branch) {
      return { status: "skipped", summary: `Epic #${epic.number} no longer delivers through ${data.branch}` };
    }
    if (data.kind === "open_pr") {
      const pr = await github.ensureEpicPr({
        host: data.host,
        repo: data.repo,
        head: data.branch,
        title: `Epic #${epic.number}: ${epic.title}`,
        body: data.body,
      });
      services.links.add(epic.id, { value: pr.url }, actor);
      if (!pr.created) await github.setPrBody({ host: data.host, repo: data.repo, number: pr.number }, data.body);
      return {
        summary: `${pr.created ? "Opened draft" : "Linked"} PR #${pr.number} from ${data.branch} for epic #${epic.number}`,
      };
    }
    const link = epic.links.find((l): l is PrLink => l.id === data.linkId && isPrLink(l));
    if (!link) return { status: "skipped", summary: "The epic's PR link was removed" };
    await github.setPrBody(link.ref, data.body);
    return { summary: `Updated the description of PR #${link.ref.number}` };
  },
});
