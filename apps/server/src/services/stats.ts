import type {
  AutopilotRun,
  StatsBreakdown,
  StatsPeriod,
  StatsResponse,
  StatsSeries,
  StatsUnit,
  TaskEvent,
} from "@repo/contracts";
import { notFound } from "../errors.ts";
import { stallKind, wasRestarted } from "./activity.ts";
import type { Core } from "./core.ts";

/** Weekly trends over the board's history, read from the activity log, reviews, Autopilot runs and links. */
export interface StatsService {
  /** The last `weeks` calendar weeks, ending with the current one, and the same number before them, for comparison. */
  weekly(weeks: StatsPeriod, projectId?: string): StatsResponse;
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

export function createStatsService(core: Core): StatsService {
  const { repos } = core;

  return {
    weekly(weeks, projectId) {
      const project = projectId ? repos.projects.get(projectId) : null;
      if (projectId && !project) throw notFound("Project", projectId);

      // 2 * weeks buckets: the second half is the period shown, the first the one it is compared with.
      const bounds = weekBoundaries(core.now(), weeks * 2);
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

      const inScope = (taskProject: string | null | undefined): boolean => !projectId || taskProject === projectId;
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

      // PRs merged, by when the board saw the merge. One PR linked to several tasks is one PR.
      const seenPrs = new Set<string>();
      for (const pr of repos.links.prsMergedBetween(start, end)) {
        if (!inScope(pr.projectId) || seenPrs.has(pr.url)) continue;
        seenPrs.add(pr.url);
        count("prs_merged", pr.at);
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
      const boundary = stamps[weeks]!;
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

      const out: Record<string, StatsSeries> = {};
      for (const [name, s] of [...built].sort(([a], [b]) => a.localeCompare(b))) {
        const perBucket = Array.from({ length: weeks * 2 }, () => [] as number[]);
        for (const sample of s.samples) perBucket[bucketOf(sample.at)]?.push(sample.value);
        out[name] = {
          unit: s.unit,
          values: perBucket.slice(weeks).map((xs) => reduce(s.aggregate, xs)),
          total: reduce(s.aggregate, perBucket.slice(weeks).flat()),
          previousTotal: reduce(s.aggregate, perBucket.slice(0, weeks).flat()),
        };
      }

      const shown = bounds.slice(weeks).map((d) => d.toISOString());
      return {
        weeks,
        from: shown[0]!,
        to: shown.at(-1)!,
        previousFrom: start,
        project: project ? { id: project.id, title: project.title } : null,
        buckets: shown.slice(0, -1).map((from, i) => ({ start: from, end: shown[i + 1]! })),
        series: out,
        breakdowns,
      };
    },
  };
}
