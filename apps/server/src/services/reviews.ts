import {
  BOARD_ACTOR,
  deriveReviewSummary,
  FindingSeverity,
  reviewSkillName,
  reviewWantsAnotherRound,
  type ReviewFinding,
  type ReviewRoundStatus,
  type ReviewSkillRef,
  type SeverityCounts,
  type TaskReview,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import type { FindingRecord, ReviewRecord } from "../db/repos/reviews.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";
import { loadSettings } from "./settings.ts";
import { toTaskReviews } from "./summaries.ts";
import type { OpenRoundOptions, ReviewsService } from "./types.ts";

/** Statuses a reviewer can still submit to. */
const SUBMITTABLE: ReadonlySet<ReviewRoundStatus> = new Set(["pending", "running", "stalled", "failed"]);

const countBySeverity = (findings: ReadonlyArray<{ severity: FindingRecord["severity"] }>): SeverityCounts => {
  const counts: SeverityCounts = { blocking: 0, major: 0, minor: 0, nit: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
};

/** Local review rounds and their findings. */
export function createReviewsService(
  core: Core,
  deps: { task: (id: string) => TaskRecord; notifications: NotificationsService },
): ReviewsService {
  const { repos } = core;

  const reviewsOf = (taskId: string): TaskReview[] =>
    toTaskReviews(repos.reviews.forTasks([taskId]), repos.reviews.findingsFor([taskId]));

  const review = (taskId: string, id: string): TaskReview => {
    const found = reviewsOf(taskId).find((r) => r.id === id);
    if (!found) throw notFound("Review", id);
    return found;
  };

  const touch = (taskId: string, fx: Effects): void => {
    repos.tasks.update({ ...deps.task(taskId), updatedAt: nowIso() });
    fx.task(taskId);
  };

  const skillFor = (taskId: string): ReviewSkillRef => {
    const project = repos.projects.get(deps.task(taskId).projectId);
    return project?.reviewSkill ?? loadSettings(repos).reviewSkill;
  };

  /** Finds a finding by id or "R2.3" label within the task. */
  const findingRecord = (taskId: string, ref: string): FindingRecord => {
    const label = /^R(\d+)\.(\d+)$/i.exec(ref.trim());
    const found = label
      ? repos.reviews.findingByLabel(taskId, Number(label[1]), Number(label[2]))
      : repos.reviews.finding(ref.trim());
    if (!found || found.taskId !== taskId) throw notFound("Finding", ref);
    return found;
  };

  const openRoundIn = (taskId: string, opts: OpenRoundOptions, fx: Effects): ReviewRecord => {
    const task = deps.task(taskId);
    if (task.kind === "epic") {
      throw new AppError("VALIDATION", `#${task.number} is an epic; review its child tasks instead`);
    }
    const latest = repos.reviews.latest(taskId);
    const now = nowIso();
    if (latest?.status === "running") {
      // A move to Review is never blocked: the review already under way covers it.
      if (opts.trigger === "move") return latest;
      throw new AppError("CONFLICT", `Round ${latest.round} is already being reviewed`);
    }
    // An unfinished round is reused rather than skipped, so round numbers only count real reviews. A move
    // still starts a new cycle on it, which resets the round limit.
    if (latest && latest.status !== "submitted") {
      // Already waiting for a reviewer. Only a move onto a manually opened round starts a new cycle.
      if (latest.status === "pending" && (opts.trigger !== "move" || latest.trigger === "move")) return latest;
      const reopened: ReviewRecord = {
        ...latest,
        status: "pending",
        trigger: opts.trigger,
        cycle: opts.trigger === "move" ? latest.cycle + 1 : latest.cycle,
        openedBy: opts.actor,
        skill: reviewSkillName(skillFor(taskId)),
        error: null,
        nudgedAt: null,
        updatedAt: now,
      };
      repos.reviews.update(reopened);
      fx.log(taskId, opts.actor, "review_opened", { round: reopened.round, trigger: opts.trigger });
      touch(taskId, fx);
      return reopened;
    }
    const cycle = latest ? (opts.trigger === "move" ? latest.cycle + 1 : latest.cycle) : 1;
    if (latest && opts.trigger !== "move" && !opts.force) {
      const inCycle = repos.reviews.forTasks([taskId]).filter((r) => r.cycle === cycle).length;
      const max = loadSettings(repos).reviewMaxRounds;
      if (inCycle >= max) {
        throw new AppError(
          "VALIDATION",
          `Already ${inCycle} review round${inCycle === 1 ? "" : "s"} for this cycle (limit ${max}). Stop reviewing, then open the pull request, unless the user asked you not to, listing any open findings in its description, and link it. If a pull request is already linked, push to it instead.`,
        );
      }
    }
    const round: ReviewRecord = {
      id: randomUUID(),
      taskId,
      round: (latest?.round ?? 0) + 1,
      cycle,
      status: "pending",
      trigger: opts.trigger,
      openedBy: opts.actor,
      reviewer: null,
      skill: reviewSkillName(skillFor(taskId)),
      headSha: null,
      summary: null,
      error: null,
      nudgedAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    repos.reviews.insert(round);
    fx.log(taskId, opts.actor, "review_opened", { round: round.round, trigger: opts.trigger });
    touch(taskId, fx);
    return round;
  };

  const service: ReviewsService = {
    list: reviewsOf,

    effectiveAutoReview(taskId) {
      const task = deps.task(taskId);
      // A manual task has no change for a reviewer to read.
      if (task.manual) return false;
      return task.autoReview ?? loadSettings(repos).autoReview;
    },

    skillFor,

    openRound(taskId, opts) {
      const id = core.write((fx) => openRoundIn(taskId, opts, fx).id);
      return review(taskId, id);
    },

    openRoundIn,

    submit(taskId, input, actor) {
      const id = core.write((fx) => {
        let round: ReviewRecord | null;
        if (input.round !== undefined) {
          round = repos.reviews.byRound(taskId, input.round);
          if (!round) throw notFound("Review round", String(input.round));
        } else {
          const latest = repos.reviews.latest(taskId);
          // A reviewer that wasn't asked through start_review still gets its findings recorded.
          round =
            latest && SUBMITTABLE.has(latest.status)
              ? latest
              : openRoundIn(taskId, { trigger: "manual", actor, force: true }, fx);
        }
        if (!SUBMITTABLE.has(round.status)) {
          throw new AppError(
            "CONFLICT",
            `Round ${round.round} was already submitted; call start_review to open the next round`,
          );
        }
        const now = nowIso();
        input.findings.forEach((f, index) => {
          repos.reviews.insertFinding({
            id: randomUUID(),
            reviewId: round.id,
            taskId,
            round: round.round,
            position: index + 1,
            severity: f.severity,
            file: f.file ?? null,
            line: f.line ?? null,
            title: f.title,
            body: f.body?.trim() || null,
            suggestion: f.suggestion?.trim() || null,
            status: "open",
            resolutionNote: null,
            resolvedBy: null,
            resolvedAt: null,
            createdAt: now,
          });
        });
        repos.reviews.update({
          ...round,
          status: "submitted",
          reviewer: actor,
          headSha: input.headSha ?? round.headSha,
          summary: input.summary?.trim() || null,
          error: null,
          updatedAt: now,
          completedAt: now,
        });
        const counts = countBySeverity(input.findings);
        fx.log(taskId, actor, "review_submitted", { round: round.round, findings: counts });
        touch(taskId, fx);
        const task = deps.task(taskId);
        const found = FindingSeverity.options.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
        deps.notifications.notify({
          kind: "review_finished",
          taskId,
          title: `Review round ${round.round} finished`,
          body: `#${task.number} ${task.title}\n${found.length > 0 ? found.join(", ") : "No findings"}`,
          dedupeKey: `review:${round.id}`,
        });
        return round.id;
      });
      return review(taskId, id);
    },

    resolveFinding(taskId, ref, input, actor): ReviewFinding {
      const id = core.write((fx) => {
        const finding = findingRecord(taskId, ref);
        const now = nowIso();
        const note = input.note?.trim() || null;
        if (input.status === "wont_fix" && !note) {
          throw new AppError("VALIDATION", "Declining a finding (wont_fix) needs a note saying why");
        }
        const reopened = input.status === "open";
        repos.reviews.updateFinding({
          ...finding,
          status: input.status,
          resolutionNote: reopened ? null : (note ?? finding.resolutionNote),
          resolvedBy: reopened ? null : actor,
          resolvedAt: reopened ? null : now,
        });
        fx.log(taskId, actor, "finding_resolved", {
          finding: `R${finding.round}.${finding.position}`,
          status: input.status,
          ...(note ? { note } : {}),
        });
        // The agent that fixed the last gating finding is mid-turn and may stop before it asks for the next round,
        // so the board opens it: the task would sit at "Fixed, re-review" with nobody to run it.
        // Only in Review: that's where the watchdog runs rounds, so on a Done or archived task it would sit pending.
        const task = deps.task(taskId);
        if (!reopened && task.status === "review" && !task.archivedAt && service.effectiveAutoReview(taskId)) {
          const summary = deriveReviewSummary(
            repos.reviews.forTasks([taskId]),
            repos.reviews.findingsFor([taskId]),
            loadSettings(repos).reviewMaxRounds,
          );
          if (summary?.state === "fixed" && reviewWantsAnotherRound(summary)) {
            openRoundIn(taskId, { trigger: "manual", actor: BOARD_ACTOR }, fx);
          }
        }
        touch(taskId, fx);
        return finding.id;
      });
      const updated = reviewsOf(taskId)
        .flatMap((r) => r.findings)
        .find((f) => f.id === id);
      return updated!;
    },

    roundsWithStatus: (status) => repos.reviews.withStatus(status),

    markNudged(reviewId, actor) {
      return core.write((fx) => {
        // Read inside the write: an agent may have submitted since the caller looked.
        const round = repos.reviews.get(reviewId);
        if (!round) throw notFound("Review", reviewId);
        if (round.status !== "pending") return false;
        const now = nowIso();
        repos.reviews.update({ ...round, nudgedAt: now, updatedAt: now });
        fx.log(round.taskId, actor, "review_nudged", { round: round.round });
        return true;
      });
    },

    setRoundStatus(reviewId, status, opts) {
      const updated = core.write((fx) => {
        // Read inside the write and check the status the caller expects, so a fallback acting on what it saw a
        // moment ago can't overwrite a round an agent has since submitted.
        const round = repos.reviews.get(reviewId);
        if (!round) throw notFound("Review", reviewId);
        if (opts.from && !opts.from.includes(round.status)) return null;
        const now = nowIso();
        repos.reviews.update({
          ...round,
          status,
          error: opts.error ?? null,
          updatedAt: now,
          completedAt: status === "failed" ? now : round.completedAt,
        });
        fx.log(round.taskId, opts.actor, "review_status", {
          round: round.round,
          status,
          ...(opts.error ? { error: opts.error } : {}),
        });
        touch(round.taskId, fx);
        return round;
      });
      return updated ? review(updated.taskId, reviewId) : null;
    },
  };

  return service;
}
