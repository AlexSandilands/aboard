import {
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_REVIEW_PRS,
  FIX_GAVE_UP_KEY_PREFIX,
  fixRunKeyPrefix,
  prReviewOutput,
  type AutopilotRun,
  type Project,
  type StatsBreakdown,
  type StatsPeriod,
  type StatsResponse,
  type StatsSeries,
  type StatsUnit,
  type TaskEvent,
} from "@repo/contracts";
import { notFound } from "../errors.ts";
import { defaultBranchCommits, type DefaultBranchCommit } from "../integrations/commitLog.ts";
import type { RunGit } from "../integrations/backup.ts";
import { OPEN_STATUSES, stallKind, statusStays, wasRestarted } from "./activity.ts";
import type { Core } from "./core.ts";

/**
 * Weekly trends over the board's history, read from the activity log, reviews, Autopilot runs and links, and from git
 * for commits.
 */
export interface StatsService {
  /**
   * The last `weeks` calendar weeks, ending with the current one, and the same number before them, for comparison.
   * One week is shown by day instead: the last 7 days ending today, against the 7 before. `projectIds` limits it to
   * those projects (a 404 for an unknown one); none is the whole board.
   */
  weekly(weeks: StatsPeriod, projectIds?: ReadonlyArray<string>): Promise<StatsResponse>;
}

/** How long a project's commit times are reused: reading them is a git process per project. */
const COMMITS_TTL_MS = 10 * 60_000;
/** The same for a read that failed. */
const FAILED_TTL_MS = 30_000;

interface ProjectCommits {
  /** Empty when git couldn't be read. */
  commits: DefaultBranchCommit[];
  note: string | null;
}

type Aggregate = "sum" | "median" | "mean";

interface Sample {
  at: number;
  value: number;
}

interface SeriesBuilder {
  unit: StatsUnit;
  aggregate: Aggregate;
  samples: Sample[];
}

/** Resolutions that close a task without it being delivered here; they aren't finished work. */
const NOT_DELIVERED = new Set(["wont_do", "duplicate"]);

/** The newest runs read per task when counting what Autopilot did on its merged PRs; older ones are not counted. */
const RUNS_PER_TASK = 2000;

/** The series that exist even on an empty board, so a client can chart them without checking. */
const COUNT_SERIES = [
  "tasks_created",
  "tasks_completed",
  "prs_merged",
  "review_rounds",
  "review_findings.blocking",
  "review_findings.major",
  "review_findings.minor",
  "review_findings.nit",
  "agent_sessions_started",
  "autopilot.runs",
  "autopilot.retries",
  "friction.steps_blocked",
  "friction.steps_skipped",
  "friction.attention_requests",
  "friction.autopilot_flags",
  "friction.stalls.stale",
  "friction.stalls.waiting",
  "friction.runs_restarted",
  "autopilot.gave_up",
  "autopilot.gave_up.review_prs",
  "autopilot.gave_up.fix_prs",
  "commits",
];

/**
 * The `count + 1` boundaries of `count` calendar weeks, Monday 00:00 in the server's local time, ending at the Monday
 * after the week `now` falls in.
 */
export function weekBoundaries(now: Date, count: number): Date[] {
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  const monday = d - ((now.getDay() + 6) % 7);
  // Built by calendar date, not by adding 7 * 24 h, so a week with a clock change still starts at midnight.
  return Array.from({ length: count + 1 }, (_, i) => new Date(y, m, monday + 7 * (i - count + 1)));
}

/** The `count + 1` boundaries of `count` calendar days, local midnight, ending at the midnight after `now`'s day. */
export function dayBoundaries(now: Date, count: number): Date[] {
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  // By calendar date, not 24 h steps, so a day with a clock change still starts at midnight.
  return Array.from({ length: count + 1 }, (_, i) => new Date(y, m, d + i - count + 1));
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function reduce(aggregate: Aggregate, xs: readonly number[]): number | null {
  if (aggregate === "sum") return sum(xs);
  if (aggregate === "mean") return xs.length ? sum(xs) / xs.length : null;
  return median(xs);
}

export function createStatsService(core: Core, deps: { runGit: RunGit }): StatsService {
  const { repos } = core;

  // Keyed by project, folder and period start, so a moved folder or a new week reads again.
  const commitCache = new Map<string, { expires: number; commits: Promise<ProjectCommits> }>();
  const commitsOf = (project: Project & { workspaceRoot: string }, since: Date): Promise<ProjectCommits> => {
    const now = core.now().getTime();
    for (const [key, entry] of commitCache) if (entry.expires <= now) commitCache.delete(key);
    const key = `${project.id}\0${project.workspaceRoot}\0${since.getTime()}`;
    let entry = commitCache.get(key);
    if (!entry) {
      const created: { expires: number; commits: Promise<ProjectCommits> } = {
        expires: now + COMMITS_TTL_MS,
        commits: Promise.resolve({ commits: [], note: null }),
      };
      // A folder git can't read is an empty series with a note, never an error: stats still answer. A failure may be
      // a timeout or a lock that passes, so it is asked again sooner than a success.
      created.commits = defaultBranchCommits(deps.runGit, project.workspaceRoot, since).then(
        (commits): ProjectCommits => ({ commits, note: null }),
        (error: unknown): ProjectCommits => {
          created.expires = core.now().getTime() + FAILED_TTL_MS;
          const why = error instanceof Error ? error.message : String(error);
          return { commits: [], note: `Commits in ${project.title} weren't counted: ${why}` };
        },
      );
      entry = created;
      commitCache.set(key, entry);
    }
    return entry.commits;
  };

  return {
    async weekly(weeks, projectIds = []) {
      const chosen = projectIds.map((id) => {
        const project = repos.projects.get(id);
        if (!project) throw notFound("Project", id);
        return project;
      });
      const chosenIds = new Set(chosen.map((p) => p.id));

      // 2 * `perPeriod` buckets: the second half is the period shown, the first the one it is compared with. A single
      // week is shown by day, so its period is 7 buckets.
      const bucket = weeks === 1 ? "day" : "week";
      const perPeriod = bucket === "day" ? 7 : weeks;
      const bounds = (bucket === "day" ? dayBoundaries : weekBoundaries)(core.now(), perPeriod * 2);
      const stamps = bounds.map((d) => d.getTime());
      const [start, end] = [bounds[0]!.toISOString(), bounds.at(-1)!.toISOString()];
      const bucketOf = (at: number): number =>
        at >= stamps[0]! && at < stamps.at(-1)! ? stamps.findLastIndex((s) => s <= at) : -1;

      const built = new Map<string, SeriesBuilder>();
      const series = (name: string, unit: StatsUnit, aggregate: Aggregate): SeriesBuilder => {
        let s = built.get(name);
        if (!s) {
          s = { unit, aggregate, samples: [] };
          built.set(name, s);
        }
        return s;
      };
      const add = (name: string, unit: StatsUnit, aggregate: Aggregate, at: string, value = 1) => {
        series(name, unit, aggregate).samples.push({ at: Date.parse(at), value });
      };
      const count = (name: string, at: string) => add(name, "count", "sum", at);
      for (const name of COUNT_SERIES) series(name, "count", "sum");
      series("autopilot.cost_usd", "usd", "sum");
      series("cycle_time.in_progress_to_done", "ms", "median");
      series("cycle_time.created_to_done", "ms", "median");
      series("review_rounds_per_task", "ratio", "mean");
      series("pr_open_to_merged", "ms", "median");
      series("autopilot.pr_review_rounds_per_pr", "ratio", "mean");
      series("autopilot.fix_attempts_per_pr", "ratio", "mean");
      for (const status of OPEN_STATUSES) {
        series(`time_in_status.${status}.average`, "ms", "mean");
        series(`time_in_status.${status}.median`, "ms", "median");
      }

      const inScope = (taskProject: string | null | undefined): boolean =>
        chosenIds.size === 0 || (taskProject != null && chosenIds.has(taskProject));
      const projectOf = new Map<string, string | null>();
      const projectOfTask = (taskId: string): string | null => {
        if (!projectOf.has(taskId)) projectOf.set(taskId, repos.tasks.get(taskId)?.projectId ?? null);
        return projectOf.get(taskId)!;
      };

      // Tasks created. Epics only group tasks, so they aren't work of their own.
      for (const e of repos.events.between(["created"], start, end)) {
        if (inScope(e.projectId) && e.payload.kind !== "epic") count("tasks_created", e.at);
      }

      // Tasks finished: the last move to Done or close of each, as the board's activity report reads it.
      const lastFinish = new Map<string, { at: string; resolution: unknown }>();
      for (const e of repos.events.between(["status_changed", "closed"], start, end)) {
        if (!inScope(e.projectId)) continue;
        if (e.type === "status_changed" && e.payload.to !== "done") continue;
        if (e.payload.fromChildren) continue;
        lastFinish.set(e.taskId, { at: e.at, resolution: e.type === "closed" ? e.payload.resolution : null });
      }
      const finished = repos.tasks
        .getMany([...lastFinish.keys()])
        .filter((t) => t.kind !== "epic" && !NOT_DELIVERED.has(String(lastFinish.get(t.id)!.resolution)));
      const finishedIds = finished.map((t) => t.id);
      const movesOf = new Map<string, TaskEvent[]>();
      for (const m of repos.events.ofTypes(finishedIds, ["status_changed", "closed"])) {
        movesOf.set(m.taskId, [...(movesOf.get(m.taskId) ?? []), m]);
      }
      const rounds = new Map<string, number>();
      for (const r of repos.reviews.forTasks(finishedIds)) rounds.set(r.taskId, (rounds.get(r.taskId) ?? 0) + 1);
      for (const task of finished) {
        const done = lastFinish.get(task.id)!.at;
        const doneAt = Date.parse(done);
        count("tasks_completed", done);
        add("cycle_time.created_to_done", "ms", "median", done, Math.max(0, doneAt - Date.parse(task.createdAt)));
        // From the first move to In Progress of the last cycle: a task that was finished and reopened starts again.
        let started: string | null = null;
        for (const m of movesOf.get(task.id) ?? []) {
          const finishes = m.type === "closed" || m.payload.to === "done";
          if (finishes && m.at >= done) break;
          if (finishes) started = null;
          else if (m.payload.to === "in_progress" && started === null) started = m.at;
        }
        if (started) {
          add("cycle_time.in_progress_to_done", "ms", "median", done, Math.max(0, doneAt - Date.parse(started)));
        }
        add("review_rounds_per_task", "ratio", "mean", done, rounds.get(task.id) ?? 0);
      }

      // Where work waits. A stay in an open status counts in the week it ended, and the tasks in each open status are
      // counted as of every week's end (as of now, for the current week). Epics follow their tasks, so they are left out.
      const nowMs = core.now().getTime();
      const snapshotTimes = stamps.slice(1).map((s) => Math.min(s, nowMs));
      const openAt = Object.fromEntries(OPEN_STATUSES.map((status) => [status, snapshotTimes.map(() => 0)] as const));
      const flowTasks = (
        chosen.length === 1
          ? repos.tasks.list({ projectId: chosen[0]!.id, includeArchived: true })
          : repos.tasks.list({ includeArchived: true }).filter((t) => inScope(t.projectId))
      ).filter((t) => t.kind !== "epic");
      const movesByTask = new Map<string, TaskEvent[]>();
      for (const m of repos.events.ofTypes(
        flowTasks.map((t) => t.id),
        ["status_changed", "closed"],
      )) {
        const moves = movesByTask.get(m.taskId);
        if (moves) moves.push(m);
        else movesByTask.set(m.taskId, [m]);
      }
      for (const task of flowTasks) {
        // An archived task is off the board, so it stops counting as open when it was archived.
        const archived = task.archivedAt ? Date.parse(task.archivedAt) : Infinity;
        for (const stay of statusStays(task.createdAt, movesByTask.get(task.id) ?? [], task.status)) {
          const status = OPEN_STATUSES.find((s) => s === stay.status);
          if (!status) continue;
          const since = Date.parse(stay.since);
          if (stay.until) {
            const waited = Math.max(0, Date.parse(stay.until) - since);
            add(`time_in_status.${status}.average`, "ms", "mean", stay.until, waited);
            add(`time_in_status.${status}.median`, "ms", "median", stay.until, waited);
          }
          const until = Math.min(stay.until ? Date.parse(stay.until) : Infinity, archived);
          snapshotTimes.forEach((t, i) => {
            if (t >= since && t < until) openAt[status]![i]! += 1;
          });
        }
      }

      // PRs merged, by when the board saw the merge. One PR linked to several tasks is one PR. It was open from the
      // first of its links. Autopilot works each link on its own, so what it did on the PR is the sum over its links: the
      // reviews of a link number from 1 (its highest round is how many it had), and every fix attempt happened.
      const mergedPrs = new Map<
        string,
        { at: string; openedAt: string; links: { linkId: string; taskId: string }[] }
      >();
      for (const pr of repos.links.prsMergedBetween(start, end)) {
        if (!inScope(pr.projectId)) continue;
        const seen = mergedPrs.get(pr.url);
        if (!seen) mergedPrs.set(pr.url, { at: pr.at, openedAt: pr.openedAt, links: [pr] });
        else {
          if (pr.openedAt < seen.openedAt) seen.openedAt = pr.openedAt;
          seen.links.push(pr);
        }
      }
      const realRuns = new Map<string, AutopilotRun[]>();
      const realRunsOf = (taskId: string): AutopilotRun[] => {
        if (!realRuns.has(taskId)) {
          realRuns.set(
            taskId,
            repos.autopilotRuns.forTask(taskId, RUNS_PER_TASK).filter((r) => !r.dryRun),
          );
        }
        return realRuns.get(taskId)!;
      };
      for (const pr of mergedPrs.values()) {
        count("prs_merged", pr.at);
        add("pr_open_to_merged", "ms", "median", pr.at, Math.max(0, Date.parse(pr.at) - Date.parse(pr.openedAt)));
        let reviewRounds = 0;
        let fixAttempts = 0;
        for (const { linkId, taskId } of pr.links) {
          let linkRounds = 0;
          for (const run of realRunsOf(taskId)) {
            const review = prReviewOutput(run);
            if (review?.linkId === linkId) linkRounds = Math.max(linkRounds, review.round);
            // A skipped attempt did nothing; conflict-only ones are attempts too.
            if (
              run.automation === AUTOPILOT_FIX_PRS &&
              run.status !== "skipped" &&
              run.dedupeKey.startsWith(fixRunKeyPrefix(linkId))
            ) {
              fixAttempts += 1;
            }
          }
          reviewRounds += linkRounds;
        }
        add("autopilot.pr_review_rounds_per_pr", "ratio", "mean", pr.at, reviewRounds);
        add("autopilot.fix_attempts_per_pr", "ratio", "mean", pr.at, fixAttempts);
      }

      // Agent sessions, by when they were first linked to a task, in that task's project.
      for (const s of repos.links.agentSessionsStartedBetween(start, end)) {
        if (inScope(s.projectId)) count("agent_sessions_started", s.at);
      }

      // Local review rounds, and the findings they raised by severity.
      for (const r of repos.reviews.roundsBetween(start, end)) {
        if (inScope(projectOfTask(r.taskId))) count("review_rounds", r.createdAt);
      }
      for (const f of repos.reviews.findingsBetween(start, end)) {
        if (inScope(projectOfTask(f.taskId))) count(`review_findings.${f.severity}`, f.createdAt);
      }

      // Autopilot runs count in the period they finished in. A run that follows a failed run of the same automation on
      // the same task is a retry; review and fix rounds run on a task again and again by design, and aren't.
      const lastOnTask = new Map<string, string>();
      const periodRuns = repos.autopilotRuns.between(start, end, []);
      const runInScope = (run: AutopilotRun): boolean =>
        inScope(run.projectId ?? (run.taskId ? projectOfTask(run.taskId) : null));
      for (const run of periodRuns) {
        if (!runInScope(run)) continue;
        const at = run.finishedAt ?? run.updatedAt;
        count("autopilot.runs", at);
        count(`autopilot.runs.${run.automation}.${run.status}`, at);
        if (run.costUsd) add("autopilot.cost_usd", "usd", "sum", at, run.costUsd);
        // Review PRs says so in its verdict; Fix PRs records a run of its own, under a dedupe key made for it.
        const gaveUp =
          run.automation === AUTOPILOT_REVIEW_PRS
            ? prReviewOutput(run)?.handoff === "gave_up"
            : run.automation === AUTOPILOT_FIX_PRS && run.dedupeKey.startsWith(FIX_GAVE_UP_KEY_PREFIX);
        if (gaveUp) {
          count("autopilot.gave_up", at);
          count(`autopilot.gave_up.${run.automation}`, at);
        }
        if (run.taskId) {
          const key = `${run.automation}:${run.taskId}`;
          if (lastOnTask.get(key) === "failed") count("autopilot.retries", at);
          lastOnTask.set(key, run.status);
        }
      }

      // Friction: steps an agent marked blocked or skipped, and requests for the user to look at a task.
      for (const e of repos.events.between(["step_updated", "attention_requested"], start, end)) {
        if (!inScope(e.projectId)) continue;
        if (e.type === "attention_requested") count("friction.attention_requests", e.at);
        else if (e.payload.to === "blocked") count("friction.steps_blocked", e.at);
        else if (e.payload.to === "skipped") count("friction.steps_skipped", e.at);
      }
      // Stalls are Unstick's findings and the inbox's "thread waiting" notices, read as the activity report reads
      // them: a task stalls one way once per week, however often it was noticed.
      const stalled = new Set<string>();
      const stall = (taskId: string, kind: string, at: string) => {
        const key = `${taskId}:${kind}:${bucketOf(Date.parse(at))}`;
        if (stalled.has(key)) return;
        stalled.add(key);
        count(`friction.stalls.${kind}`, at);
      };
      for (const run of periodRuns) {
        if (!runInScope(run)) continue;
        const at = run.finishedAt ?? run.updatedAt;
        // A restart flags the runs it strands, but that is the board's doing, not Autopilot asking: count it once.
        if (wasRestarted(run)) count("friction.runs_restarted", at);
        else if (run.needsAttention) count("friction.autopilot_flags", at);
        const kind = stallKind(run);
        if (kind) stall(run.taskId!, kind, at);
      }
      for (const n of repos.notifications.between(["thread_waiting"], start, end)) {
        if (n.taskId && inScope(projectOfTask(n.taskId))) stall(n.taskId, "waiting", n.createdAt);
      }

      // Breakdowns split the period by category rather than by week: what finished, and what ran sessions.
      const boundary = stamps[perPeriod]!;
      const breakdown = (entries: { key: string | null; at: number }[]): StatsBreakdown => {
        const rows = new Map<string | null, { total: number; previousTotal: number }>();
        for (const { key, at } of entries) {
          const row = rows.get(key) ?? { total: 0, previousTotal: 0 };
          if (at >= boundary) row.total += 1;
          else row.previousTotal += 1;
          rows.set(key, row);
        }
        const items = [...rows].map(([key, r]) => ({ key, ...r }));
        items.sort(
          (a, b) =>
            b.total - a.total ||
            b.previousTotal - a.previousTotal ||
            (a.key === null ? 1 : b.key === null ? -1 : a.key.localeCompare(b.key)),
        );
        return { unit: "count", items };
      };
      const labelsOf = repos.labels.forTasks(finishedIds);
      const doneAt = (id: string): number => Date.parse(lastFinish.get(id)!.at);
      const breakdowns: Record<string, StatsBreakdown> = {
        completed_by_label: breakdown(
          finished.flatMap((t) => {
            const labels = labelsOf.get(t.id);
            return (labels?.length ? labels : [null]).map((key) => ({ key, at: doneAt(t.id) }));
          }),
        ),
        completed_by_tier: breakdown(finished.map((t) => ({ key: t.suggestedModel?.tier ?? null, at: doneAt(t.id) }))),
        sessions_by_harness: breakdown(
          repos.links
            .sessionsStartedBetween(start, end)
            .filter((s) => inScope(s.projectId))
            .map((s) => ({ key: s.harness, at: Date.parse(s.at) })),
        ),
      };
      // Commits that reached each project's default branch, by when they landed. A project without a folder has no
      // history to read (said so for the ones asked for; on the whole board it is just not counted).
      const notes: string[] = [];
      const inFolders = (chosen.length ? chosen : repos.projects.list(true)).filter(
        (p): p is Project & { workspaceRoot: string } => p.workspaceRoot !== null,
      );
      for (const p of chosen) {
        if (p.workspaceRoot === null) notes.push(`${p.title} has no folder, so its commits aren't counted`);
      }
      // Projects on one repository (another folder in it, or a second clone) share its commits: each counts once.
      const seenCommits = new Set<string>();
      for (const commits of await Promise.all(inFolders.map((p) => commitsOf(p, bounds[0]!)))) {
        for (const commit of commits.commits) {
          if (seenCommits.has(commit.hash)) continue;
          seenCommits.add(commit.hash);
          count("commits", commit.at);
        }
        if (commits.note) notes.push(commits.note);
      }

      const computed = new Map<string, StatsSeries>();
      for (const [name, s] of built) {
        const perBucket = Array.from({ length: perPeriod * 2 }, () => [] as number[]);
        for (const sample of s.samples) perBucket[bucketOf(sample.at)]?.push(sample.value);
        computed.set(name, {
          unit: s.unit,
          values: perBucket.slice(perPeriod).map((xs) => reduce(s.aggregate, xs)),
          total: reduce(s.aggregate, perBucket.slice(perPeriod).flat()),
          previousTotal: reduce(s.aggregate, perBucket.slice(0, perPeriod).flat()),
        });
      }
      // Open tasks are a level, not events: a period's total is where it ended, the previous one's where that ended.
      for (const status of OPEN_STATUSES) {
        const levels = openAt[status]!;
        computed.set(`open_tasks.${status}`, {
          unit: "count",
          values: levels.slice(perPeriod),
          total: levels[perPeriod * 2 - 1]!,
          previousTotal: levels[perPeriod - 1]!,
        });
      }
      const out: Record<string, StatsSeries> = Object.fromEntries([...computed].sort(([a], [b]) => a.localeCompare(b)));

      const shown = bounds.slice(perPeriod).map((d) => d.toISOString());
      return {
        weeks,
        bucket,
        from: shown[0]!,
        to: shown.at(-1)!,
        previousFrom: start,
        projects: chosen.map((p) => ({ id: p.id, title: p.title })),
        buckets: shown.slice(0, -1).map((from, i) => ({ start: from, end: shown[i + 1]! })),
        series: out,
        breakdowns,
        notes,
      };
    },
  };
}
