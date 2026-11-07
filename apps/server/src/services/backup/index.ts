import {
  TASK_BUNDLE_TABLES,
  type BackupDiffTask,
  type BackupRow,
  type BoardDump,
  type TaskBundle,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import type { Core } from "../core.ts";
import { syncEpicStatus } from "../tasks.ts";
import { dumpBoard } from "./dump.ts";
import { copyAttachmentFiles } from "./files.ts";
import type { NotificationsService } from "../notifications.ts";
import { insertRows, restoreBoardLive, upgradeDump, type LiveRestoreResult } from "./restore.ts";
import { createTransferService, type TransferService } from "./transfers.ts";

export interface RestoreTaskResult {
  taskId: string;
  /** The task's number on this board: the backup's, unless another task holds it by now. */
  number: number;
}

export interface BackupDiffResult {
  counts: { backup: number; board: number; missing: number; changed: number };
  tasks: BackupDiffTask[];
}

/** A row's JSON with its keys sorted, so the same row compares equal whatever order its columns came in. */
const sortedRow = (row: BackupRow) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));
const bundleKey = (bundle: TaskBundle) =>
  [sortedRow(bundle.task), ...TASK_BUNDLE_TABLES.map((table) => bundle[table].map(sortedRow).join("\n"))].join("\n\n");

export interface BackupService extends TransferService {
  /** The whole board as a dump (see files.ts for writing it out). */
  dump(): BoardDump;
  /**
   * Puts one task from a backup back on the live board: its plan, links, labels, reviews and history. Refuses if
   * the task is still on the board unless `force`, which replaces it. Its project must be on the board.
   */
  restoreTask(
    dump: BoardDump,
    number: number,
    options: {
      force?: boolean;
      actor: string;
      /** The backup folder the dump came from; the task's pasted images are copied from its `attachments/`. */
      attachmentsFrom?: string | null;
    },
  ): RestoreTaskResult;
  /** The backup's tasks that the board doesn't have, or has with other contents, by number. */
  diff(dump: BoardDump): BackupDiffResult;
  /**
   * Replaces the whole live board with the dump (see restoreBoardLive), copies its pasted images back from
   * `attachmentsFrom`, and publishes board.reset.
   */
  restoreBoard(dump: BoardDump, options: { attachmentsFrom: string | null }): LiveRestoreResult;
}

export function createBackupService(
  core: Core,
  attachmentsDir: string,
  deps: { instanceId: string; notifications: () => NotificationsService },
): BackupService {
  const { db, repos } = core;
  return {
    ...createTransferService(core, { attachmentsDir, ...deps }),
    dump: () => dumpBoard(db),
    diff(dump) {
      const backup = upgradeDump(dump);
      const board = dumpBoard(db);
      const onBoard = new Map(board.tasks.map((b) => [String(b.task.id), bundleKey(b)]));
      const boardProjects = new Set(board.projects.map((p) => String(p.id)));
      const projectNames = new Map(
        [...backup.projects, ...board.projects].map((p) => [String(p.id), String(p.title)] as const),
      );
      const tasks = backup.tasks.flatMap((bundle): BackupDiffTask[] => {
        const id = String(bundle.task.id);
        const current = onBoard.get(id);
        if (current === bundleKey(bundle)) return [];
        const projectId = String(bundle.task.project_id);
        return [
          {
            number: Number(bundle.task.number),
            taskId: id,
            title: String(bundle.task.title),
            status: String(bundle.task.status),
            kind: String(bundle.task.kind ?? "task"),
            projectName: projectNames.get(projectId) ?? null,
            projectOnBoard: boardProjects.has(projectId),
            change: current === undefined ? "missing" : "changed",
          },
        ];
      });
      return {
        counts: {
          backup: backup.tasks.length,
          board: board.tasks.length,
          missing: tasks.filter((t) => t.change === "missing").length,
          changed: tasks.filter((t) => t.change === "changed").length,
        },
        tasks,
      };
    },
    restoreBoard(dump, { attachmentsFrom }) {
      const result = restoreBoardLive(db, dump, core.now());
      copyAttachmentFiles(
        dump.tasks.flatMap((b) => b.task_attachments),
        attachmentsFrom,
        attachmentsDir,
      );
      core.bus.publish({ type: "board.reset" });
      return result;
    },
    restoreTask(dump, number, { force = false, actor, attachmentsFrom = null }) {
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
        // What blocks it and what it blocks: kept as they are now when replacing, else taken from the backup.
        let relations = current.task_relations.filter((r) => r.blocker_id === taskId || r.blocked_id === taskId);
        if (repos.tasks.get(taskId)) {
          if (!force) throw new AppError("CONFLICT", `Task #${number} is still on the board. Use force to replace it.`);
          closedAgainst = repos.tasks.resolvedBy([taskId]).map((t) => t.id);
          children = repos.tasks.childIdsAny(taskId);
          relations = repos.relations.forTasks([taskId]).map((r) => ({
            blocker_id: r.blockerId,
            blocked_id: r.blockedId,
            created_at: r.createdAt,
            actor: r.actor,
          }));
          repos.tasks.delete(taskId);
        } else if (repos.tasks.getAny(taskId)) {
          // In the trash here: the backup's copy replaces it, and keeps its number. An epic keeps its tasks, those
          // deleted with it included, so they can still come back into it.
          children = repos.tasks.childIdsAny(taskId);
          repos.tasks.delete(taskId);
        }
        const projectId = String(bundle.task.project_id);
        if (!repos.projects.get(projectId)) {
          throw new AppError("NOT_FOUND", `Task #${number}'s project (${projectId}) is not on the board`);
        }
        // Restoring a task brings it back to the board, even one that was in the backup's trash.
        const task: BackupRow = { ...bundle.task, deleted_at: null };
        if (repos.tasks.byNumberAny(number)) task.number = repos.tasks.nextNumber();
        else db.prepare("UPDATE counters SET value = max(value, ?) WHERE name = 'task_number'").run(number);
        if (task.resolved_by_task_id && !repos.tasks.get(String(task.resolved_by_task_id))) {
          task.resolved_by_task_id = null;
        }
        // Its template may have been deleted since the backup; the task keeps what it copied.
        if (task.template_id && !repos.templates.get(String(task.template_id))) task.template_id = null;
        // Back into its epic only if that is still an epic in the same project; otherwise it comes back loose.
        const epic = task.parent_id ? repos.tasks.get(String(task.parent_id)) : null;
        if (task.parent_id && (epic?.kind !== "epic" || epic.projectId !== projectId)) task.parent_id = null;

        insertRows(db, "tasks", [task]);
        for (const table of TASK_BUNDLE_TABLES) insertRows(db, table, bundle[table]);
        insertRows(db, "task_events", events);
        // Only to tasks still on the board, and not where it would now close a loop.
        for (const r of relations) {
          const [blocker, blocked] = [String(r.blocker_id), String(r.blocked_id)];
          if (!repos.tasks.get(blocker) || !repos.tasks.get(blocked) || repos.relations.path(blocked, blocker))
            continue;
          repos.relations.add(blocker, blocked, String(r.created_at), String(r.actor));
          fx.task(blocker === taskId ? blocked : blocker);
        }
        for (const id of closedAgainst) {
          db.prepare("UPDATE tasks SET resolved_by_task_id = ? WHERE id = ?").run(taskId, id);
          fx.task(id);
        }
        for (const id of children) {
          // A task that moved to another project since the backup stays loose: an epic's tasks share its project.
          if (repos.tasks.getAny(id)?.projectId === projectId) {
            db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(taskId, id);
          }
          fx.task(id);
        }
        fx.log(taskId, actor, "restored", { backupNumber: number });
        // A restored epic, or the epic a task came back into, takes its status from its tasks as they are now.
        syncEpicStatus(repos, taskId, actor, fx);
        if (task.parent_id) syncEpicStatus(repos, String(task.parent_id), actor, fx);
        copyAttachmentFiles(bundle.task_attachments, attachmentsFrom, attachmentsDir);
        return { taskId, number: Number(task.number) };
      });
    },
  };
}
