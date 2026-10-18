import type {
  FindingSeverity,
  FindingStatus,
  ReviewFinding,
  ReviewRoundStatus,
  ReviewTrigger,
  TaskReview,
} from "@repo/contracts";
import { jsonList, type Sql } from "./sql.ts";

/** A task_reviews row in domain shape (without findings). */
export type ReviewRecord = Omit<TaskReview, "findings">;

/** A review_findings row in domain shape; `round` comes from the joined review. */
export interface FindingRecord extends Omit<ReviewFinding, "label"> {
  taskId: string;
  round: number;
  position: number;
}

interface ReviewRow {
  id: string;
  task_id: string;
  round: number;
  cycle: number;
  status: ReviewRoundStatus;
  trigger: ReviewTrigger;
  opened_by: string;
  reviewer: string | null;
  skill: string | null;
  head_sha: string | null;
  summary: string | null;
  error: string | null;
  nudged_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface FindingRow {
  id: string;
  review_id: string;
  task_id: string;
  position: number;
  severity: FindingSeverity;
  file: string | null;
  line: number | null;
  title: string;
  body: string | null;
  suggestion: string | null;
  status: FindingStatus;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const toReview = (r: ReviewRow): ReviewRecord => ({
  id: r.id,
  taskId: r.task_id,
  round: r.round,
  cycle: r.cycle,
  status: r.status,
  trigger: r.trigger,
  openedBy: r.opened_by,
  reviewer: r.reviewer,
  skill: r.skill,
  headSha: r.head_sha,
  summary: r.summary,
  error: r.error,
  nudgedAt: r.nudged_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

const toReviewRow = (r: ReviewRecord): ReviewRow => ({
  id: r.id,
  task_id: r.taskId,
  round: r.round,
  cycle: r.cycle,
  status: r.status,
  trigger: r.trigger,
  opened_by: r.openedBy,
  reviewer: r.reviewer,
  skill: r.skill,
  head_sha: r.headSha,
  summary: r.summary,
  error: r.error,
  nudged_at: r.nudgedAt,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
  completed_at: r.completedAt,
});

const toFinding = (r: FindingRow & { round: number }): FindingRecord => ({
  id: r.id,
  reviewId: r.review_id,
  taskId: r.task_id,
  round: r.round,
  position: r.position,
  severity: r.severity,
  file: r.file,
  line: r.line,
  title: r.title,
  body: r.body,
  suggestion: r.suggestion,
  status: r.status,
  resolutionNote: r.resolution_note,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  createdAt: r.created_at,
});

const toFindingRow = (f: FindingRecord): FindingRow => ({
  id: f.id,
  review_id: f.reviewId,
  task_id: f.taskId,
  position: f.position,
  severity: f.severity,
  file: f.file,
  line: f.line,
  title: f.title,
  body: f.body,
  suggestion: f.suggestion,
  status: f.status,
  resolution_note: f.resolutionNote,
  resolved_by: f.resolvedBy,
  resolved_at: f.resolvedAt,
  created_at: f.createdAt,
});

const FINDINGS_SELECT = "SELECT f.*, r.round FROM review_findings f JOIN task_reviews r ON r.id = f.review_id";

/** Typed access to task_reviews and review_findings. */
export function createReviewsRepo(sql: Sql) {
  return {
    get(id: string): ReviewRecord | null {
      const row = sql.get<ReviewRow>("SELECT * FROM task_reviews WHERE id = ?", id);
      return row ? toReview(row) : null;
    },
    byRound(taskId: string, round: number): ReviewRecord | null {
      const row = sql.get<ReviewRow>("SELECT * FROM task_reviews WHERE task_id = ? AND round = ?", taskId, round);
      return row ? toReview(row) : null;
    },
    latest(taskId: string): ReviewRecord | null {
      const row = sql.get<ReviewRow>(
        "SELECT * FROM task_reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1",
        taskId,
      );
      return row ? toReview(row) : null;
    },
    /** Rounds of many tasks, by task then round. */
    forTasks(taskIds: readonly string[]): ReviewRecord[] {
      return sql
        .all<ReviewRow>(
          "SELECT * FROM task_reviews WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY task_id, round",
          jsonList(taskIds),
        )
        .map(toReview);
    },
    /** Rounds in a status on non-archived tasks, oldest first: for the watchdog. */
    withStatus(status: ReviewRoundStatus): ReviewRecord[] {
      return sql
        .all<ReviewRow>(
          `SELECT r.* FROM task_reviews r JOIN tasks t ON t.id = r.task_id
           WHERE r.status = ? AND t.archived_at IS NULL ORDER BY r.created_at, r.id`,
          status,
        )
        .map(toReview);
    },
    /** Rounds opened at or after `from` and before `to`, oldest first. */
    roundsBetween(from: string, to: string): ReviewRecord[] {
      return sql
        .all<ReviewRow>(
          "SELECT * FROM task_reviews WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id",
          from,
          to,
        )
        .map(toReview);
    },
    /** Findings raised at or after `from` and before `to`, oldest first. */
    findingsBetween(from: string, to: string): FindingRecord[] {
      return sql
        .all<FindingRow & { round: number }>(
          `${FINDINGS_SELECT} WHERE f.created_at >= ? AND f.created_at < ? ORDER BY f.created_at, r.round, f.position`,
          from,
          to,
        )
        .map(toFinding);
    },
    /** Tasks with at least one round. */
    taskIds(): string[] {
      return sql.all<{ task_id: string }>("SELECT DISTINCT task_id FROM task_reviews").map((r) => r.task_id);
    },
    insert(r: ReviewRecord): void {
      sql.insert("task_reviews", { ...toReviewRow(r) });
    },
    update(r: ReviewRecord): void {
      sql.update("task_reviews", { ...toReviewRow(r) });
    },

    finding(id: string): FindingRecord | null {
      const row = sql.get<FindingRow & { round: number }>(`${FINDINGS_SELECT} WHERE f.id = ?`, id);
      return row ? toFinding(row) : null;
    },
    findingByLabel(taskId: string, round: number, position: number): FindingRecord | null {
      const row = sql.get<FindingRow & { round: number }>(
        `${FINDINGS_SELECT} WHERE f.task_id = ? AND r.round = ? AND f.position = ?`,
        taskId,
        round,
        position,
      );
      return row ? toFinding(row) : null;
    },
    /** Findings of many tasks, by task, round and position. */
    findingsFor(taskIds: readonly string[]): FindingRecord[] {
      return sql
        .all<FindingRow & { round: number }>(
          `${FINDINGS_SELECT} WHERE f.task_id IN (SELECT value FROM json_each(?)) ORDER BY f.task_id, r.round, f.position`,
          jsonList(taskIds),
        )
        .map(toFinding);
    },
    insertFinding(f: FindingRecord): void {
      sql.insert("review_findings", { ...toFindingRow(f) });
    },
    updateFinding(f: FindingRecord): void {
      sql.update("review_findings", { ...toFindingRow(f) });
    },
  };
}
