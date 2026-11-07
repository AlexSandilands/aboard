import type { EscalationReason, RepoPrOutcome } from "@repo/contracts";
import type { Sql } from "./sql.ts";

/** What Autopilot last did on another person's PR (Review PRs' second source). */
export interface RepoPrReviewState {
  host: string;
  repo: string;
  number: number;
  projectId: string;
  url: string;
  title: string;
  author: string | null;
  headOid: string;
  round: number;
  outcome: RepoPrOutcome;
  reason: EscalationReason | null;
  reasonDetail: string | null;
  handoffCommentId: string | null;
  handoffCommentUrl: string | null;
  taskId: string | null;
  readySince: string | null;
  updatedAt: string;
}

interface Row {
  host: string;
  repo: string;
  number: number;
  project_id: string;
  url: string;
  title: string;
  author: string | null;
  head_oid: string;
  round: number;
  outcome: RepoPrOutcome;
  reason: EscalationReason | null;
  reason_detail: string | null;
  handoff_comment_id: string | null;
  handoff_comment_url: string | null;
  task_id: string | null;
  ready_since: string | null;
  updated_at: string;
}

const toState = (r: Row): RepoPrReviewState => ({
  host: r.host,
  repo: r.repo,
  number: r.number,
  projectId: r.project_id,
  url: r.url,
  title: r.title,
  author: r.author,
  headOid: r.head_oid,
  round: r.round,
  outcome: r.outcome,
  reason: r.reason,
  reasonDetail: r.reason_detail,
  handoffCommentId: r.handoff_comment_id,
  handoffCommentUrl: r.handoff_comment_url,
  taskId: r.task_id,
  readySince: r.ready_since,
  updatedAt: r.updated_at,
});

/** Typed access to repo_pr_reviews, keyed by host, repository and PR number. */
export function createRepoPrReviewsRepo(sql: Sql) {
  return {
    get(host: string, repo: string, number: number): RepoPrReviewState | null {
      const row = sql.get<Row>(
        "SELECT * FROM repo_pr_reviews WHERE host = ? AND repo = ? AND number = ?",
        host,
        repo,
        number,
      );
      return row ? toState(row) : null;
    },
    /** The PRs of one repository Autopilot has state for. */
    inRepo(host: string, repo: string): RepoPrReviewState[] {
      return sql
        .all<Row>("SELECT * FROM repo_pr_reviews WHERE host = ? AND repo = ? ORDER BY number", host, repo)
        .map(toState);
    },
    /** Clean PRs waiting for the user's approval, oldest wait first. */
    ready(): RepoPrReviewState[] {
      return sql
        .all<Row>("SELECT * FROM repo_pr_reviews WHERE ready_since IS NOT NULL ORDER BY ready_since, number")
        .map(toState);
    },
    upsert(s: RepoPrReviewState): void {
      sql.run("DELETE FROM repo_pr_reviews WHERE host = ? AND repo = ? AND number = ?", s.host, s.repo, s.number);
      sql.insert("repo_pr_reviews", {
        host: s.host,
        repo: s.repo,
        number: s.number,
        project_id: s.projectId,
        url: s.url,
        title: s.title,
        author: s.author,
        head_oid: s.headOid,
        round: s.round,
        outcome: s.outcome,
        reason: s.reason,
        reason_detail: s.reasonDetail,
        handoff_comment_id: s.handoffCommentId,
        handoff_comment_url: s.handoffCommentUrl,
        task_id: s.taskId,
        ready_since: s.readySince,
        updated_at: s.updatedAt,
      });
    },
    /** Lifts a PR off Needs you; true when it was on it. */
    clearReady(host: string, repo: string, number: number, at: string): boolean {
      return (
        sql.run(
          "UPDATE repo_pr_reviews SET ready_since = NULL, updated_at = ? WHERE host = ? AND repo = ? AND number = ? AND ready_since IS NOT NULL",
          at,
          host,
          repo,
          number,
        ).changes > 0
      );
    },
    /** Forgets the manual task (closed, or the user resumed); true when there was one. */
    clearTask(host: string, repo: string, number: number, at: string): boolean {
      return (
        sql.run(
          "UPDATE repo_pr_reviews SET task_id = NULL, updated_at = ? WHERE host = ? AND repo = ? AND number = ? AND task_id IS NOT NULL",
          at,
          host,
          repo,
          number,
        ).changes > 0
      );
    },
  };
}
