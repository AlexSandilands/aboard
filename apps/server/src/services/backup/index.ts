import { TASK_BUNDLE_TABLES, type BoardDump } from "@repo/contracts";
import { AppError } from "../../errors.ts";
import type { Core } from "../core.ts";
import { syncEpicStatus } from "../tasks.ts";
import { dumpBoard } from "./dump.ts";
import { insertRows, upgradeDump } from "./restore.ts";

export interface RestoreTaskResult {
  taskId: string;
  /** The task's number on this board: the backup's, unless another task holds it by now. */
  number: number;
}

export interface BackupService {
  /** The whole board as a dump (see files.ts for writing it out). */
  dump(): BoardDump;
  /**
   * Puts one task from a backup back on the live board: its plan, links, labels, reviews and history. Refuses if
   * the task is still on the board unless `force`, which replaces it. Its project must be on the board.
   */
  restoreTask(dump: BoardDump, number: number, options: { force?: boolean; actor: string }): RestoreTaskResult;
}

export function createBackupService(core: Core): BackupService {
  const { db, repos } = core;
  return {
    dump: () => dumpBoard(db),
    restoreTask(dump, number, { force = false, actor }) {
      // Before the write: upgrading an older dump runs its own transaction on a scratch database.
      const current = upgradeDump(dump);
      const bundle = current.tasks.find((b) => b.task.number === number);
      if (!bundle) throw new AppError("NOT_FOUND", `Task #${number} is not in this backup`);
      const taskId = String(bundle.task.id);
      const events = current.task_events.filter((e) => e.task_id === taskId).map(({ id: _id, ...event }) => event);

      return core.write((fx) => {
        // Tasks closed against the one being replaced; deleting it nulls their pointer, so it's put back after.
        let closedAgainst: string[] = [];
        // Likewise an epic's tasks, whose parent_id deleting it nulls.
        let children: string[] = [];
        if (repos.tasks.get(taskId)) {
          if (!force) throw new AppError("CONFLICT", `Task #${number} is still on the board. Use force to replace it.`);
          closedAgainst = repos.tasks.resolvedBy([taskId]).map((t) => t.id);
          children = repos.tasks.childrenOf([taskId]).map((t) => t.id);
          repos.tasks.delete(taskId);
        }
        const projectId = String(bundle.task.project_id);
        if (!repos.projects.get(projectId)) {
          throw new AppError("NOT_FOUND", `Task #${number}'s project (${projectId}) is not on the board`);
        }
        const task = { ...bundle.task };
        if (repos.tasks.byNumber(number)) task.number = repos.tasks.nextNumber();
        else db.prepare("UPDATE counters SET value = max(value, ?) WHERE name = 'task_number'").run(number);
        if (task.resolved_by_task_id && !repos.tasks.get(String(task.resolved_by_task_id))) {
          task.resolved_by_task_id = null;
        }
        // Back into its epic only if that is still an epic in the same project; otherwise it comes back loose.
        const epic = task.parent_id ? repos.tasks.get(String(task.parent_id)) : null;
        if (task.parent_id && (epic?.kind !== "epic" || epic.projectId !== projectId)) task.parent_id = null;

        insertRows(db, "tasks", [task]);
        for (const table of TASK_BUNDLE_TABLES) insertRows(db, table, bundle[table]);
        insertRows(db, "task_events", events);
        for (const id of closedAgainst) {
          db.prepare("UPDATE tasks SET resolved_by_task_id = ? WHERE id = ?").run(taskId, id);
          fx.task(id);
        }
        for (const id of children) {
          // A task that moved to another project since the backup stays loose: an epic's tasks share its project.
          if (repos.tasks.get(id)?.projectId === projectId) {
            db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(taskId, id);
          }
          fx.task(id);
        }
        fx.log(taskId, actor, "restored", { backupNumber: number });
        // A restored epic, or the epic a task came back into, takes its status from its tasks as they are now.
        syncEpicStatus(repos, taskId, actor, fx);
        if (task.parent_id) syncEpicStatus(repos, String(task.parent_id), actor, fx);
        return { taskId, number: Number(task.number) };
      });
    },
  };
}
