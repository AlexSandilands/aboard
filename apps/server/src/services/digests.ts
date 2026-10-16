import { randomUUID } from "node:crypto";
import {
  AUTOPILOT_DIGEST,
  DIGEST_FIRST_PERIOD_MS,
  DIGEST_KEEP,
  type Digest,
  type DigestList,
  type DigestMode,
  type DigestTrigger,
  type NotificationKind,
  type TaskStatus,
} from "@repo/contracts";
import {
  type DigestAttention,
  type DigestData,
  type DigestMerge,
  type DigestMove,
  type DigestProjectData,
  type DigestRunProblem,
} from "../autopilot/digestBuilder.ts";
import { notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";

/** The notifications that mean a task started needing the user; failed runs have their own section. */
const ATTENTION_KINDS: readonly NotificationKind[] = ["thread_waiting", "pr_checks_failing", "pr_changes_requested"];

export interface CreateDigestInput {
  from: Date;
  to: Date;
  mode: DigestMode;
  trigger: DigestTrigger;
  bodyMd: string;
  costUsd: number | null;
  note: string | null;
  /** One line for the inbox notification: what changed, in counts. */
  headline: string;
}

/** The digests Autopilot has made (docs/features/autopilot.md#automations). */
export interface DigestsService {
  /** Newest first, and how many are unread. */
  list(limit?: number): DigestList;
  get(id: string): Digest;
  latest(): Digest | null;
  markRead(id: string): Digest;
  /** What a digest made at `now` covers: from the previous one's end (the last 24 hours for the first) to `now`. */
  period(now: Date): { from: Date; to: Date };
  /** What changed in `[from, to)` in the projects the digest covers (every project but those switched Off). */
  collect(from: Date, to: Date): DigestData;
  /** Stores a digest, keeps the newest 30, and tells the inbox. */
  create(input: CreateDigestInput): Digest;
}

export function createDigestsService(
  core: Core,
  deps: { notifications: NotificationsService; automationTitle: (key: string) => string },
): DigestsService {
  const { repos } = core;

  const get = (id: string): Digest => {
    const digest = repos.autopilotDigests.get(id);
    if (!digest) throw notFound("Digest", id);
    return digest;
  };

  return {
    list: (limit = DIGEST_KEEP) => ({
      items: repos.autopilotDigests.list(limit),
      unread: repos.autopilotDigests.unread(),
    }),

    get,

    latest: () => repos.autopilotDigests.latest(),

    markRead(id) {
      return core.write((fx) => {
        const digest = get(id);
        if (!repos.autopilotDigests.markRead(id, core.now().toISOString())) return digest;
        fx.autopilot();
        return get(id);
      });
    },

    period(now) {
      const previous = repos.autopilotDigests.latest();
      const end = previous ? new Date(previous.to) : null;
      return { from: end && end < now ? end : new Date(now.getTime() - DIGEST_FIRST_PERIOD_MS), to: now };
    },

    collect(from, to) {
      const [start, end] = [from.toISOString(), to.toISOString()];
      // A project with the digest switched Off at its own scope is left out; the board's switch is the schedule's.
      const off = new Set(
        repos.autopilotSettings
          .all()
          .filter((s) => s.scopeKind === "project" && s.automation === AUTOPILOT_DIGEST && s.mode === "off")
          .map((s) => s.scopeId),
      );
      const projects = new Map<string, DigestProjectData>(
        repos.projects
          .list()
          .filter((p) => !off.has(p.id))
          .map((p) => [
            p.id,
            {
              title: p.title,
              moves: [],
              merged: [],
              attention: [],
              runs: { total: 0, succeeded: 0, failed: 0, problems: [] },
            },
          ]),
      );

      // Status moves: a task that moved several times shows where it started and ended, and not at all when it came
      // back. A move that a merged pull request made is listed with the pull request instead.
      const moves = new Map<
        string,
        { project: string; number: number; title: string; from: TaskStatus; to: TaskStatus; pr: string | null }
      >();
      for (const e of repos.events.between(["status_changed"], start, end)) {
        const moved = e.payload.to as TaskStatus;
        const pr = typeof e.payload.mergedPr === "string" ? e.payload.mergedPr : null;
        const seen = moves.get(e.taskId);
        moves.set(e.taskId, {
          project: e.projectId,
          number: e.number,
          title: e.title,
          from: seen?.from ?? (e.payload.from as TaskStatus),
          to: moved,
          pr: pr ?? seen?.pr ?? null,
        });
      }
      for (const m of moves.values()) {
        const project = projects.get(m.project);
        if (!project) continue;
        if (m.pr) project.merged.push({ number: m.number, title: m.title, pr: m.pr } satisfies DigestMerge);
        else if (m.from !== m.to) {
          project.moves.push({ number: m.number, title: m.title, from: m.from, to: m.to } satisfies DigestMove);
        }
      }

      const flagged = new Set<string>();
      for (const n of repos.notifications.between(ATTENTION_KINDS, start, end)) {
        const task = n.taskId ? repos.tasks.get(n.taskId) : null;
        const project = task ? projects.get(task.projectId) : null;
        if (!task || !project || flagged.has(`${task.id}:${n.kind}`)) continue;
        flagged.add(`${task.id}:${n.kind}`);
        project.attention.push({ number: task.number, title: task.title, kind: n.kind } satisfies DigestAttention);
      }

      // Runs count in the period they finished in, so a long one that fails later is reported then. The digest's
      // own runs would only describe themselves.
      let costUsd = 0;
      for (const run of repos.autopilotRuns.between(start, end, [AUTOPILOT_DIGEST])) {
        costUsd += run.costUsd ?? 0;
        const project = run.projectId ? projects.get(run.projectId) : null;
        if (!project) continue;
        const { runs } = project;
        runs.total += 1;
        if (run.status === "succeeded") runs.succeeded += 1;
        if (run.status === "failed") runs.failed += 1;
        if (run.status === "failed" || run.needsAttention) {
          runs.problems.push({
            number: run.taskId ? (repos.tasks.get(run.taskId)?.number ?? null) : null,
            automation: deps.automationTitle(run.automation),
            failed: run.status === "failed",
            message: run.error ?? run.summary,
          } satisfies DigestRunProblem);
        }
      }

      return { from, to, projects: [...projects.values()], costUsd };
    },

    create(input) {
      return core.write((fx) => {
        const now = core.now();
        const digest: Digest = {
          id: randomUUID(),
          createdAt: now.toISOString(),
          from: input.from.toISOString(),
          to: input.to.toISOString(),
          mode: input.mode,
          trigger: input.trigger,
          bodyMd: input.bodyMd,
          costUsd: input.costUsd,
          note: input.note,
          readAt: null,
        };
        repos.autopilotDigests.insert(digest);
        repos.autopilotDigests.prune(DIGEST_KEEP);
        deps.notifications.notify({
          kind: "autopilot_notice",
          title: "Digest of what changed",
          body: input.headline,
          dedupeKey: `digest:${digest.id}`,
        });
        fx.autopilot();
        return digest;
      });
    },
  };
}
