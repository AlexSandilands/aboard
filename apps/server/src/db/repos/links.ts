import type {
  AgentSessionRef,
  AgentSessionSnapshot,
  IssueRef,
  IssueSnapshot,
  LinkKind,
  PrChanges,
  PrRef,
  PrSnapshot,
  T3ThreadRef,
  T3ThreadSnapshot,
  TaskLink,
} from "@repo/contracts";
import { parseJson } from "../database.ts";
import { jsonList, type Sql } from "./sql.ts";

export interface LinkRow {
  id: string;
  task_id: string;
  kind: LinkKind;
  url: string;
  label: string | null;
  ref_json: string | null;
  snapshot_json: string | null;
  synced_at: string | null;
  created_at: string;
}

/** Maps a task_links row to the contract's discriminated TaskLink. */
export function toLink(r: LinkRow): TaskLink {
  const base = {
    id: r.id,
    taskId: r.task_id,
    url: r.url,
    label: r.label,
    syncedAt: r.synced_at,
    createdAt: r.created_at,
  };
  switch (r.kind) {
    case "pr":
      return {
        ...base,
        kind: "pr",
        ref: parseJson<PrRef>(r.ref_json),
        snapshot: parseJson<PrSnapshot>(r.snapshot_json),
      };
    case "jira":
      return { ...base, kind: "jira", ref: parseJson<{ key: string }>(r.ref_json) ?? { key: r.url } };
    case "t3_thread":
      return {
        ...base,
        kind: "t3_thread",
        ref: parseJson<T3ThreadRef>(r.ref_json) ?? { environmentId: "", threadId: "" },
        snapshot: parseJson<T3ThreadSnapshot>(r.snapshot_json),
      };
    case "issue":
      return {
        ...base,
        kind: "issue",
        ref: parseJson<IssueRef>(r.ref_json) ?? { host: "", repo: "", number: 0 },
        snapshot: parseJson<IssueSnapshot>(r.snapshot_json),
      };
    case "agent_session": {
      // The window a board-started session opened in is stored beside the ref, not in it: agents write refs.
      const { window, ...ref } = parseJson<AgentSessionRef & { window?: string }>(r.ref_json) ?? {
        harness: "claude-code",
        sessionId: "",
        cwd: "",
      };
      return {
        ...base,
        kind: "agent_session",
        ref,
        snapshot: parseJson<AgentSessionSnapshot>(r.snapshot_json),
        ...(window ? { window } : {}),
      };
    }
    case "url":
      return { ...base, kind: "url" };
  }
}

/** Typed access to task_links. */
export function createLinksRepo(sql: Sql) {
  return {
    row(id: string): LinkRow | null {
      return sql.get<LinkRow>("SELECT * FROM task_links WHERE id = ?", id) ?? null;
    },
    find(taskId: string, kind: LinkKind, url: string): LinkRow | null {
      return (
        sql.get<LinkRow>("SELECT * FROM task_links WHERE task_id = ? AND kind = ? AND url = ?", taskId, kind, url) ??
        null
      );
    },
    forTasks(taskIds: readonly string[]): LinkRow[] {
      return sql.all<LinkRow>(
        "SELECT * FROM task_links WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id",
        jsonList(taskIds),
      );
    },
    /** Links of a kind whose task is not archived. */
    byKindActive(kind: LinkKind): LinkRow[] {
      return sql.all<LinkRow>(
        `SELECT l.* FROM task_links l JOIN tasks t ON t.id = l.task_id
         WHERE l.kind = ? AND t.archived_at IS NULL ORDER BY l.created_at, l.id`,
        kind,
      );
    },
    insert(r: LinkRow): void {
      sql.insert("task_links", { ...r });
    },
    setRef(id: string, refJson: string): void {
      sql.run("UPDATE task_links SET ref_json = ? WHERE id = ?", refJson, id);
    },
    setLabel(id: string, label: string | null): void {
      sql.run("UPDATE task_links SET label = ? WHERE id = ?", label, id);
    },
    setSnapshot(id: string, snapshotJson: string | null, syncedAt: string): void {
      sql.run("UPDATE task_links SET snapshot_json = ?, synced_at = ? WHERE id = ?", snapshotJson, syncedAt, id);
    },
    setPrChanges(id: string, changes: PrChanges): void {
      sql.run("UPDATE task_links SET pr_changes_json = ? WHERE id = ?", JSON.stringify(changes), id);
    },
    /** When each PR fact began, per link id; links with none recorded are left out. */
    prChanges(ids: readonly string[]): Map<string, PrChanges> {
      const rows = sql.all<{ id: string; pr_changes_json: string | null }>(
        "SELECT id, pr_changes_json FROM task_links WHERE id IN (SELECT value FROM json_each(?)) AND pr_changes_json IS NOT NULL",
        jsonList(ids),
      );
      return new Map(rows.map((r) => [r.id, JSON.parse(r.pr_changes_json!) as PrChanges]));
    },
    /** PR links whose merge the board saw at or after `from` and before `to`, with the task's project. */
    prsMergedBetween(from: string, to: string): { url: string; projectId: string; at: string }[] {
      return sql
        .all<{ url: string; project_id: string; at: string }>(
          `SELECT l.url, t.project_id, json_extract(l.pr_changes_json, '$.merged') AS at
           FROM task_links l JOIN tasks t ON t.id = l.task_id
           WHERE l.kind = 'pr' AND l.pr_changes_json IS NOT NULL
             AND json_extract(l.pr_changes_json, '$.merged') >= ? AND json_extract(l.pr_changes_json, '$.merged') < ?
           ORDER BY at, l.id`,
          from,
          to,
        )
        .map((r) => ({ url: r.url, projectId: r.project_id, at: r.at }));
    },
    /**
     * Agent sessions first linked to a task at or after `from` and before `to`, with that task's project. A session
     * linked again later, or to other tasks, counts only where it was first linked. T3 threads aren't agent sessions.
     */
    agentSessionsStartedBetween(from: string, to: string): { projectId: string; at: string }[] {
      // One dedupe rule for both, so `agent_sessions_started` and the by-harness breakdown can't drift apart.
      return this.sessionsStartedBetween(from, to)
        .filter((s) => s.harness !== "t3_thread")
        .map(({ projectId, at }) => ({ projectId, at }));
    },
    /**
     * Agent sessions and T3 threads first linked to a task in the window, with the task's project and what ran them:
     * the session's harness, or `t3_thread`. Counted once each, where first linked, like `agentSessionsStartedBetween`.
     */
    sessionsStartedBetween(from: string, to: string): { projectId: string; at: string; harness: string }[] {
      return sql
        .all<{ project_id: string; at: string; harness: string }>(
          `SELECT project_id, at, harness FROM (
             SELECT t.project_id, l.created_at AS at,
                    CASE l.kind WHEN 'agent_session' THEN COALESCE(json_extract(l.ref_json, '$.harness'), 'claude-code')
                                ELSE 't3_thread' END AS harness,
                    ROW_NUMBER() OVER (
                      PARTITION BY l.kind, COALESCE(json_extract(l.ref_json, '$.sessionId'), json_extract(l.ref_json, '$.threadId'), l.id)
                      ORDER BY l.created_at, l.id
                    ) AS n
             FROM task_links l JOIN tasks t ON t.id = l.task_id WHERE l.kind IN ('agent_session', 't3_thread')
           ) WHERE n = 1 AND at >= ? AND at < ? ORDER BY at`,
          from,
          to,
        )
        .map((r) => ({ projectId: r.project_id, at: r.at, harness: r.harness }));
    },
    delete(id: string): void {
      sql.run("DELETE FROM task_links WHERE id = ?", id);
    },
  };
}
