import { randomUUID } from "node:crypto";
import {
  TASK_BUNDLE_TABLES,
  transferFromRow,
  transferRow,
  type BackupRow,
  type BoardDump,
  type ImportProject,
  type ImportTask,
  type ImportTaskResult,
  type MachineInfo,
  type TaskTransfer,
  type TransferMode,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import type { Core } from "../core.ts";
import type { NotificationsService } from "../notifications.ts";
import { syncEpicStatus } from "../tasks.ts";
import { copyAttachmentFiles } from "./files.ts";
import { insertRows, upgradeDump } from "./restore.ts";

// Moving and copying tasks between boards through the backup repo (docs/features/backup.md#moving-tasks-between-
// machines). The board taking a task keeps its uuid, gives it a number of its own and, for a move, records a transfer;
// the board it came from reads that transfer from the repo and archives its copy through applyTransfer, the one way
// a transfer is acted on, so one that arrives twice (by git, later by a live link) is applied once.

/** Links that only mean something on the machine that made them: a T3 thread or an agent session runs there. */
const MACHINE_LINK_KINDS = new Set(["t3_thread", "agent_session"]);

/** The machine folder a dump was read from. */
export interface TransferSource {
  folder: string;
  instanceId: string | null;
}

export interface ImportOptions {
  mode: TransferMode;
  /** Backup project id to a project here; the rest go where matchProjects matched them. */
  projectMap: Readonly<Record<string, string>>;
  source: TransferSource;
  /** This machine's name, which the transfer names as where the task went. */
  machineName: string;
  /** The source machine's machine.json: its tasks with work going on, its projects' remotes. */
  info: MachineInfo;
  /** This board's projects' remotes (normalizeRemote), by project id. */
  remotes: ReadonlyMap<string, string>;
  /** The folder the dump was read from, for the tasks' pasted images. */
  attachmentsFrom: string | null;
  actor: string;
}

export type ApplyOutcome = "archived" | "skipped" | "already_applied" | "not_ours";

export interface TransferService {
  /** The projects of another machine's backup and the project here each one goes into, if any matched. */
  matchProjects(dump: BoardDump, info: MachineInfo, remotes: ReadonlyMap<string, string>): ImportProject[];
  /** Another machine's tasks as offered for moving or copying here. */
  offer(dump: BoardDump, info: MachineInfo): ImportTask[];
  /**
   * Brings tasks from another machine's backup onto this board, each on its own (one failing doesn't stop the rest).
   * A move records a transfer, which that machine's next backup run acts on.
   */
  importTasks(dump: BoardDump, taskIds: readonly string[], options: ImportOptions): ImportTaskResult[];
  /**
   * Acts on another board's move of one of this board's tasks: archives its copy, says where it went, and tells the
   * inbox when it changed here after the backup it was taken from. Idempotent by transferId. Not ours (another board
   * moved it), or already applied: does nothing.
   */
  applyTransfer(transfer: TaskTransfer, options: { actor: string; folder?: string }): ApplyOutcome;
  /** Tasks with an agent session or Autopilot run going, which another machine may copy but not move. */
  busyTaskIds(): string[];
}

export function createTransferService(
  core: Core,
  deps: {
    attachmentsDir: string;
    instanceId: string;
    notifications: () => NotificationsService;
  },
): TransferService {
  const { db, repos } = core;

  const busyTaskIds = (): string[] =>
    (
      db
        .prepare(
          `SELECT task_id AS id FROM autopilot_runs WHERE task_id IS NOT NULL AND status IN ('queued', 'running')
           UNION
           SELECT task_id AS id FROM task_links
             WHERE kind = 'agent_session' AND json_extract(snapshot_json, '$.status') IN ('busy', 'idle', 'running')
           ORDER BY id`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id);

  const matchProjects = (dump: BoardDump, info: MachineInfo, remotes: ReadonlyMap<string, string>): ImportProject[] => {
    const here = repos.projects.list(true);
    const live = here.filter((p) => p.archivedAt === null);
    return dump.projects.map((row) => {
      const id = String(row.id);
      const title = String(row.title);
      const remote = info.remotes[id] ?? null;
      // The same project (a board restored from this one shares its ids), then the same repo, then the same name.
      const byId = here.find((p) => p.id === id);
      const byRemote = remote ? live.find((p) => remotes.get(p.id) === remote) : undefined;
      const byName = live.find((p) => p.title.trim().toLowerCase() === title.trim().toLowerCase());
      const [match, by] = byId
        ? [byId, "id" as const]
        : byRemote
          ? [byRemote, "remote" as const]
          : byName
            ? [byName, "name" as const]
            : [null, null];
      return { id, title, remote, matchId: match?.id ?? null, matchedBy: by };
    });
  };

  const offer = (dump: BoardDump, info: MachineInfo): ImportTask[] => {
    const busy = new Set(info.busyTaskIds);
    return dump.tasks.map(({ task }) => {
      const id = String(task.id);
      const onBoard = repos.tasks.get(id);
      return {
        taskId: id,
        number: Number(task.number),
        title: String(task.title),
        status: String(task.status),
        kind: String(task.kind ?? "task"),
        projectId: String(task.project_id),
        archived: task.archived_at !== null && task.archived_at !== undefined,
        onBoard: !onBoard ? "no" : onBoard.archivedAt === null ? "here" : "archived",
        busy: busy.has(id),
      };
    });
  };

  const importOne = (
    dump: BoardDump,
    bundle: BoardDump["tasks"][number],
    targetProject: string,
    options: ImportOptions,
  ): { number: number; dropped: number } => {
    const taskId = String(bundle.task.id);
    const fromNumber = Number(bundle.task.number);
    return core.write((fx) => {
      // An archived copy here (moved away earlier, or archived by hand) is replaced; a live one never is.
      const existing = repos.tasks.get(taskId);
      if (existing && existing.archivedAt === null) {
        throw new AppError("CONFLICT", `Already on this board as #${existing.number}`);
      }
      if (!repos.projects.get(targetProject)) throw new AppError("NOT_FOUND", `No project ${targetProject} here`);
      let closedAgainst: string[] = [];
      let children: string[] = [];
      let relations = dump.task_relations.filter((r) => r.blocker_id === taskId || r.blocked_id === taskId);
      if (existing) {
        closedAgainst = repos.tasks.resolvedBy([taskId]).map((t) => t.id);
        children = repos.tasks.childrenOf([taskId]).map((t) => t.id);
        relations = [
          ...relations,
          ...repos.relations.forTasks([taskId]).map((r) => ({
            blocker_id: r.blockerId,
            blocked_id: r.blockedId,
            created_at: r.createdAt,
            actor: r.actor,
          })),
        ];
        repos.tasks.delete(taskId);
      }
      // Its old number here when it comes back; a new one otherwise, as the other board's numbers mean nothing here.
      const number = existing ? existing.number : repos.tasks.nextNumber();
      const task: BackupRow = {
        ...bundle.task,
        number,
        project_id: targetProject,
        archived_at: null,
        moved_to_json: null,
      };
      if (task.resolved_by_task_id && !repos.tasks.get(String(task.resolved_by_task_id))) {
        task.resolved_by_task_id = null;
      }
      if (task.template_id && !repos.templates.get(String(task.template_id))) task.template_id = null;
      // Into its epic only if that epic is here, in the project it lands in.
      const epic = task.parent_id ? repos.tasks.get(String(task.parent_id)) : null;
      if (task.parent_id && (epic?.kind !== "epic" || epic.projectId !== targetProject || epic.archivedAt !== null)) {
        task.parent_id = null;
      }
      const links = bundle.task_links.filter((l) => !MACHINE_LINK_KINDS.has(String(l.kind)));
      const dropped = bundle.task_links.length - links.length;
      insertRows(db, "tasks", [task]);
      for (const table of TASK_BUNDLE_TABLES) {
        insertRows(db, table, table === "task_links" ? links : bundle[table]);
      }
      insertRows(
        db,
        "task_events",
        dump.task_events.filter((e) => e.task_id === taskId).map(({ id: _id, ...event }) => event),
      );
      const seen = new Set<string>();
      for (const r of relations) {
        const [blocker, blocked] = [String(r.blocker_id), String(r.blocked_id)];
        const key = `${blocker}>${blocked}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!repos.tasks.get(blocker) || !repos.tasks.get(blocked) || repos.relations.path(blocked, blocker)) continue;
        repos.relations.add(blocker, blocked, String(r.created_at), String(r.actor));
        fx.task(blocker === taskId ? blocked : blocker);
      }
      for (const id of closedAgainst) {
        db.prepare("UPDATE tasks SET resolved_by_task_id = ? WHERE id = ?").run(taskId, id);
        fx.task(id);
      }
      for (const id of children) {
        if (repos.tasks.get(id)?.projectId === targetProject) {
          db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(taskId, id);
        }
        fx.task(id);
      }
      if (options.mode === "move") {
        const transfer: TaskTransfer = {
          transferId: randomUUID(),
          taskId,
          from: options.source.folder,
          fromInstanceId: options.source.instanceId,
          fromNumber,
          sourceUpdatedAt: String(bundle.task.updated_at),
          toMachine: options.machineName,
          toInstanceId: deps.instanceId,
          toNumber: number,
          at: core.now().toISOString(),
        };
        insertRows(db, "task_transfers", [transferRow(transfer)]);
      }
      fx.log(taskId, options.actor, "imported", {
        mode: options.mode,
        from: options.source.folder,
        fromNumber,
        ...(existing ? { replaced: true } : {}),
        ...(dropped ? { droppedLinks: dropped } : {}),
      });
      syncEpicStatus(repos, taskId, options.actor, fx);
      if (task.parent_id) syncEpicStatus(repos, String(task.parent_id), options.actor, fx);
      copyAttachmentFiles(bundle.task_attachments, options.attachmentsFrom, deps.attachmentsDir);
      return { number, dropped };
    });
  };

  const importTasks = (backup: BoardDump, taskIds: readonly string[], options: ImportOptions): ImportTaskResult[] => {
    // Before any write: upgrading an older dump runs its own transaction on a scratch database.
    const dump = upgradeDump(backup);
    const bundles = new Map(dump.tasks.map((b) => [String(b.task.id), b]));
    const projects = new Map(matchProjects(dump, options.info, options.remotes).map((p) => [p.id, p]));
    const busy = new Set(options.info.busyTaskIds);
    const machine = options.source.folder;
    // Epics first, so a task brought in with its epic goes back into it.
    const ordered = [...new Set(taskIds)].sort(
      (a, b) => Number(bundles.get(b)?.task.kind === "epic") - Number(bundles.get(a)?.task.kind === "epic"),
    );
    const results = new Map<string, ImportTaskResult>();
    for (const taskId of ordered) {
      const bundle = bundles.get(taskId);
      const base = {
        taskId,
        number: bundle ? Number(bundle.task.number) : 0,
        title: bundle ? String(bundle.task.title) : "",
      };
      try {
        if (!bundle) throw new AppError("NOT_FOUND", `${machine}'s backup has no such task`);
        if (options.mode === "move" && busy.has(taskId)) {
          throw new AppError(
            "CONFLICT",
            `An agent session or Autopilot run was going on it at ${machine}'s last backup; copy it, or move it once that's done`,
          );
        }
        const sourceProject = String(bundle.task.project_id);
        const target = options.projectMap[sourceProject] ?? projects.get(sourceProject)?.matchId ?? null;
        if (!target) {
          const title = projects.get(sourceProject)?.title ?? sourceProject;
          throw new AppError("VALIDATION", `Pick a project here for ${title}`);
        }
        const { number, dropped } = importOne(dump, bundle, target, options);
        const warnings = [
          options.mode === "copy" && busy.has(taskId)
            ? `Work was going on it at ${machine}'s last backup; that copy carries on there.`
            : null,
          dropped ? `${dropped} T3 thread or agent session link${dropped === 1 ? "" : "s"} left behind.` : null,
        ].filter(Boolean);
        results.set(taskId, {
          ...base,
          ok: true,
          boardNumber: number,
          error: null,
          warning: warnings.length ? warnings.join(" ") : null,
        });
      } catch (error) {
        results.set(taskId, {
          ...base,
          ok: false,
          boardNumber: null,
          error: error instanceof Error ? error.message : String(error),
          warning: null,
        });
      }
    }
    return [...new Set(taskIds)].map((id) => results.get(id)!);
  };

  const applied = (transferId: string) =>
    db.prepare("SELECT 1 FROM applied_transfers WHERE transfer_id = ?").get(transferId) !== undefined;

  /** Whether this board took the task back after `at` (its own transfer, recorded when it moved it in). */
  const cameBackSince = (taskId: string, at: string): boolean => {
    const latest = db
      .prepare("SELECT max(at) AS at FROM task_transfers WHERE task_id = ? AND to_instance_id = ?")
      .get(taskId, deps.instanceId) as { at: string | null };
    return latest.at !== null && latest.at > at;
  };

  const applyTransfer = (transfer: TaskTransfer, { actor, folder }: { actor: string; folder?: string }) => {
    // From this board: by its id, or for a folder no board had claimed when it was read, by the folder it backs up to.
    const ours =
      transfer.fromInstanceId === deps.instanceId ||
      (transfer.fromInstanceId === null &&
        folder !== undefined &&
        folder.toLowerCase() === transfer.from.toLowerCase());
    if (!ours || transfer.toInstanceId === deps.instanceId) return "not_ours";
    return core.write((fx): ApplyOutcome => {
      if (applied(transfer.transferId)) return "already_applied";
      const task = repos.tasks.get(transfer.taskId);
      const now = core.now().toISOString();
      // Nothing to archive: deleted here since, or taken back here after this move (a later move wins).
      const outcome = !task || cameBackSince(transfer.taskId, transfer.at) ? "skipped" : "archived";
      insertRows(db, "applied_transfers", [
        {
          transfer_id: transfer.transferId,
          task_id: transfer.taskId,
          outcome,
          applied_at: now,
        },
      ]);
      if (!task || outcome === "skipped") return outcome;
      const changed = task.updatedAt > transfer.sourceUpdatedAt;
      const busy = busyTaskIds().includes(task.id);
      // Its open tasks stay here, loose: an archived epic would hide them while they still claim it.
      if (task.kind === "epic") {
        for (const child of repos.tasks.childrenOf([task.id]).filter((c) => c.archivedAt === null)) {
          repos.tasks.update({ ...child, parentId: null, updatedAt: now });
          fx.log(child.id, actor, "epic_changed", {
            from: task.number,
            to: null,
            epicMoved: true,
          });
        }
      }
      repos.tasks.update({
        ...task,
        archivedAt: task.archivedAt ?? now,
        movedTo: {
          machine: transfer.toMachine,
          number: transfer.toNumber,
          at: transfer.at,
        },
        updatedAt: now,
      });
      fx.log(task.id, actor, "moved_away", {
        machine: transfer.toMachine,
        number: transfer.toNumber,
        transferId: transfer.transferId,
        ...(changed ? { changedSince: true } : {}),
        ...(busy ? { busy: true } : {}),
      });
      if (task.parentId) syncEpicStatus(repos, task.parentId, actor, fx);
      if (changed || busy) {
        deps.notifications().notify({
          kind: "backup_notice",
          taskId: task.id,
          title: `#${task.number} moved to ${transfer.toMachine} with changes left here`,
          body:
            `#${task.number} "${task.title}" was moved to ${transfer.toMachine} as #${transfer.toNumber}, and archived ` +
            "here. " +
            [
              changed ? "It changed here after the backup it was moved from, so those changes didn't go with it." : "",
              busy ? "An agent session or Autopilot run was still going on it here." : "",
            ]
              .filter(Boolean)
              .join(" ") +
            " Compare the two copies, and carry over anything missing by hand.",
          dedupeKey: `backup_notice:moved:${transfer.transferId}`,
        });
      }
      return "archived";
    });
  };

  return {
    matchProjects,
    offer,
    importTasks,
    applyTransfer,
    busyTaskIds,
  };
}

/**
 * The transfers to act on from every machine folder's transfers.json, oldest first: applyTransfer sorts out which are
 * this board's, and a later move of a task back here wins over an earlier one away.
 */
export function transfersIn(rowsByFolder: ReadonlyArray<readonly BackupRow[]>): TaskTransfer[] {
  const byId = new Map<string, TaskTransfer>();
  for (const rows of rowsByFolder) {
    for (const row of rows) {
      const transfer = transferFromRow(row);
      if (transfer) byId.set(transfer.transferId, transfer);
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.at === b.at ? a.transferId.localeCompare(b.transferId) : a.at.localeCompare(b.at),
  );
}
