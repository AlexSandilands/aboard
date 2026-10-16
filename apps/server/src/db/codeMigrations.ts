import { classifyLink } from "@repo/contracts";
import type { Db } from "./database.ts";

/**
 * Migrations that need code rather than SQL, such as parsing a URL. Each runs once, in name order
 * with the `.sql` files, inside the same transaction and bookkeeping.
 */
export const CODE_MIGRATIONS: Readonly<Record<string, (db: Db) => void>> = {
  "008_enterprise_pr_links": reclassifyPrLinks,
};

/**
 * PR URLs on any host now parse as GitHub-style PRs (GitHub Enterprise), so links stored as plain
 * URLs, or as PRs with no ref, are given the ref the parser now finds. A plain URL that duplicates a
 * PR link on the same task is dropped, as adding it again would have returned the existing link.
 */
function reclassifyPrLinks(db: Db): void {
  const rows = db
    .prepare("SELECT id, task_id, kind, url FROM task_links WHERE kind = 'url' OR (kind = 'pr' AND ref_json IS NULL)")
    .all() as Array<{ id: string; task_id: string; kind: string; url: string }>;
  const duplicate = db.prepare("SELECT 1 FROM task_links WHERE task_id = ? AND kind = 'pr' AND url = ? AND id <> ?");
  const remove = db.prepare("DELETE FROM task_links WHERE id = ?");
  const update = db.prepare("UPDATE task_links SET kind = 'pr', ref_json = ? WHERE id = ?");
  for (const row of rows) {
    const classified = classifyLink(row.url);
    if (classified?.kind !== "pr" || !classified.ref) continue;
    if (row.kind === "url" && duplicate.get(row.task_id, row.url, row.id)) {
      remove.run(row.id);
      continue;
    }
    update.run(JSON.stringify(classified.ref), row.id);
  }
}
