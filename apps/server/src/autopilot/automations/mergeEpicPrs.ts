import { createHash } from "node:crypto";
import {
  AUTOPILOT_MERGE_EPIC_PRS,
  BRAND,
  describeCounts,
  prReviewOutput,
  TASK_STATUSES,
  type AutopilotRun,
  type TaskSummary,
} from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import { MergeTargetError, messageOf } from "../../integrations/github.ts";
import { isTransientGithubError } from "../../integrations/githubApi.ts";
import { headSeenSince, isPrLink, notMergeable, type PrLink } from "../mergeGate.ts";
import { defineAutomation, type ActionResult, type Candidate } from "../types.ts";

export { AUTOPILOT_MERGE_EPIC_PRS };

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

/** Merge failures that pass on their own besides GitHub's and the network's: a race with another merge or a push. */
const MERGE_RACE = /base branch was modified|head branch was modified/i;

interface EpicPrData {
  kind: "open_pr" | "update_pr";
  branch: string;
  host: string;
  repo: string;
  /** The epic's PR link, when it has one (update). */
  linkId: string | null;
  body: string;
  /** The PR's title, set only when it is opened (open_pr). Absent in data queued before it existed. */
  title?: string;
}

/** On a skipped merge run: it settled nothing, so the head may be tried again. */
const RETRY = { retry: true };
/** A skip from the re-check before the merge: nothing was tried, so it doesn't count as a try. */
const RECHECK = { retry: true, recheck: true };

/** The task's PRs that go into the branch: polled, from origin (not a fork), with the branch as their base. */
const prsInto = (task: TaskSummary, branch: string): PrLink[] =>
  task.links.filter(
    (l): l is PrLink => isPrLink(l) && l.snapshot?.baseRef === branch && l.snapshot.isCrossRepository !== true,
  );

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
    `📋 ${BRAND.name} Autopilot merges each task's pull request into \`${branch}\` once its reviews are finished and its checks pass, and keeps this description current. It never merges this pull request: that is yours, once you're happy with the whole epic.`,
    "",
    `## Tasks (${done} of ${counted.length} done)`,
    "",
    ...counted
      .slice()
      .sort((a, b) => a.number - b.number)
      .map((c) => taskLine(c, branch, runsOf(c.id))),
  ].join("\n");
}

export interface ConventionalHeader {
  type: string;
  scope: string | null;
  breaking: boolean;
  subject: string;
}

/** config-conventional's type-enum: a header with any other type fails commitlint, so it doesn't count as conventional. */
const TYPES = new Set(["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"]);

/** `type(scope)!: subject`, the header shape of config-conventional. Null for anything else. */
export function parseConventionalHeader(title: string): ConventionalHeader | null {
  const match = /^([a-z]+)(?:\(([^()\s][^()]*)\))?(!)?: (\S.*)$/.exec(title.trim());
  if (!match || !TYPES.has(match[1]!)) return null;
  return { type: match[1]!, scope: match[2] ?? null, breaking: match[3] === "!", subject: match[4]!.trim() };
}

/** commitlint's header-max-length in config-conventional. */
const HEADER_MAX = 100;

/** The type that stands for a set of children: feat, else fix, else the most common (ties go to the first of the epic's tasks). */
function dominantType(types: readonly string[]): string {
  if (types.includes("feat")) return "feat";
  if (types.includes("fix")) return "fix";
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best = types[0]!;
  for (const [t, n] of counts) if (n > counts.get(best)!) best = t;
  return best;
}

/**
 * Lowercases the first word when it starts with a capital: config-conventional's subject-case rejects a subject whose
 * first character is upper case, so `GitHub sync` and `API keys` become `github sync` and `api keys`.
 */
function lowerFirst(subject: string): string {
  const [word = ""] = subject.split(" ");
  return /^[A-Z]/.test(word) ? word.toLowerCase() + subject.slice(word.length) : subject;
}

/** The epic's title as a commit subject: whitespace collapsed, no trailing period, first word lowercased. */
const subjectOf = (title: string) => lowerFirst(title.replace(/\s+/g, " ").trim().replace(/\.+$/, ""));

function header(type: string, scope: string | null, breaking: boolean, subject: string): string {
  const prefix = `${type}${scope ? `(${scope})` : ""}${breaking ? "!" : ""}: `;
  return prefix + cut(subject, HEADER_MAX - prefix.length);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max - 1);
  const space = clipped.lastIndexOf(" ");
  return `${(space > max / 2 ? clipped.slice(0, space) : clipped).trimEnd()}…`;
}

/**
 * The title for the epic's PR. When any merged child PR has a Conventional Commits title the repo lints PR titles, so
 * the epic's gets one too (no epic number: a `#N` in the squash commit would link to the repo's issue #N). Otherwise
 * `Epic #N: <title>`.
 */
export function epicPrTitle(epic: Pick<TaskSummary, "number" | "title">, childPrTitles: readonly string[]): string {
  const children = childPrTitles.flatMap((t) => parseConventionalHeader(t) ?? []);
  if (children.length === 0) return `Epic #${epic.number}: ${epic.title}`;

  // An epic already titled as a header keeps its parts; its subject gets the same clean-up as a built one.
  const own = parseConventionalHeader(epic.title.replace(/\s+/g, " "));
  if (own) return header(own.type, own.scope, own.breaking, subjectOf(own.subject));

  const type = dominantType(children.map((c) => c.type));
  const scopes = new Set(children.map((c) => c.scope));
  const scope = scopes.size === 1 ? [...scopes][0]! : null;
  const breaking = children.some((c) => c.breaking);
  return header(type, scope, breaking, subjectOf(epic.title));
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
 * - merges a task's PR into the branch once `notMergeable` finds nothing in the way: with a merge commit if the
 *   repository allows one, else a squash, else a rebase (mergeIntoEpicBranch). Once per PR
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
          ...(own
            ? {}
            : {
                title: epicPrTitle(
                  epic,
                  merged.map((l) => l.snapshot?.title ?? ""),
                ),
              }),
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
      let method: string;
      try {
        ({ method } = await github.mergeIntoEpicBranch(link, { base: data.branch, headOid: data.headOid }));
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
        const passing =
          (error instanceof AppError && error.code === "CONFLICT") ||
          MERGE_RACE.test(message) ||
          isTransientGithubError(error);
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
      return { summary: `Merged PR #${data.number} into ${data.branch} (${method})` };
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
        title: data.title ?? `Epic #${epic.number}: ${epic.title}`,
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
