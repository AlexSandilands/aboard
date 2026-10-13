import type { LinkKind, PrRef, PrSnapshot, T3ThreadRef, T3ThreadSnapshot, TaskLink } from "@repo/contracts";
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
    setSnapshot(id: string, snapshotJson: string | null, syncedAt: string): void {
      sql.run("UPDATE task_links SET snapshot_json = ?, synced_at = ? WHERE id = ?", snapshotJson, syncedAt, id);
    },
    delete(id: string): void {
      sql.run("DELETE FROM task_links WHERE id = ?", id);
    },
  };
}
