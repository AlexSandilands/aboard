import type { HeldEditOp, TaskReference } from "@repo/contracts";
import { parseJson } from "../database.ts";
import { jsonList, type Sql } from "./sql.ts";

/** A task handed to a machine, as the board stores it. */
export interface HoldRecord {
  taskId: string;
  machineId: string;
  heldAt: string;
  /** The machine's log position when it took the task; its entries for the task up to it are from an earlier hold. */
  afterLogId: number;
}

/** How far the board has applied a machine's change log. */
export interface MachineSyncRecord {
  machineId: string;
  epoch: string | null;
  appliedLogId: number;
}

/** An edit made on the board to a held task, waiting for its machine. */
export interface HeldEditRecord {
  seq: number;
  id: string;
  taskId: string;
  machineId: string;
  op: HeldEditOp;
  args: unknown[];
  ids: string[];
  references: TaskReference[];
  /** The activity entries the board wrote when it showed the edit; the machine's own replace them. */
  eventIds: number[];
  /** The machine's log position carrying the outcome; null while the edit hasn't reached it. */
  settledHead: number | null;
  createdAt: string;
}

interface HoldRow {
  task_id: string;
  machine_id: string;
  held_at: string;
  after_log_id: number;
}

interface EditRow {
  seq: number;
  id: string;
  task_id: string;
  machine_id: string;
  op: HeldEditOp;
  args_json: string;
  ids_json: string;
  references_json: string;
  event_ids_json: string;
  settled_head: number | null;
  created_at: string;
}

const toHold = (r: HoldRow): HoldRecord => ({
  taskId: r.task_id,
  machineId: r.machine_id,
  heldAt: r.held_at,
  afterLogId: r.after_log_id,
});

const toEdit = (r: EditRow): HeldEditRecord => ({
  seq: r.seq,
  id: r.id,
  taskId: r.task_id,
  machineId: r.machine_id,
  op: r.op,
  args: parseJson<unknown[]>(r.args_json) ?? [],
  ids: parseJson<string[]>(r.ids_json) ?? [],
  references: parseJson<TaskReference[]>(r.references_json) ?? [],
  eventIds: parseJson<number[]>(r.event_ids_json) ?? [],
  settledHead: r.settled_head,
  createdAt: r.created_at,
});

/** Typed access to what a board keeps about tasks its machines hold: the holds, the log positions, the edit queue. */
export function createHoldsRepo(sql: Sql) {
  return {
    get(taskId: string): HoldRecord | null {
      const row = sql.get<HoldRow>("SELECT * FROM task_holds WHERE task_id = ?", taskId);
      return row ? toHold(row) : null;
    },
    forTasks(taskIds: readonly string[]): Map<string, HoldRecord> {
      const rows = sql.all<HoldRow>(
        "SELECT * FROM task_holds WHERE task_id IN (SELECT value FROM json_each(?))",
        jsonList(taskIds),
      );
      return new Map(rows.map((r) => [r.task_id, toHold(r)]));
    },
    forMachine(machineId: string): HoldRecord[] {
      return sql.all<HoldRow>("SELECT * FROM task_holds WHERE machine_id = ? ORDER BY held_at", machineId).map(toHold);
    },
    /** How many tasks of a project are held, by any machine. */
    countInProject(projectId: string): number {
      return (
        sql.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM task_holds h JOIN tasks t ON t.id = h.task_id WHERE t.project_id = ?",
          projectId,
        )?.n ?? 0
      );
    },
    any(): boolean {
      return sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM task_holds")!.n > 0;
    },
    insert(hold: HoldRecord): void {
      sql.run(
        "INSERT INTO task_holds (task_id, machine_id, held_at, after_log_id) VALUES (?, ?, ?, ?)",
        hold.taskId,
        hold.machineId,
        hold.heldAt,
        hold.afterLogId,
      );
    },
    /** Forgets where a machine's holds started in its log: the log is another one now, and its ids start again. */
    resetLogPositions(machineId: string): void {
      sql.run("UPDATE task_holds SET after_log_id = 0 WHERE machine_id = ?", machineId);
    },
    delete(taskId: string): boolean {
      return Number(sql.run("DELETE FROM task_holds WHERE task_id = ?", taskId).changes) > 0;
    },

    sync(machineId: string): MachineSyncRecord {
      const row = sql.get<{ epoch: string | null; applied_log_id: number }>(
        "SELECT epoch, applied_log_id FROM machine_sync WHERE machine_id = ?",
        machineId,
      );
      return { machineId, epoch: row?.epoch ?? null, appliedLogId: row?.applied_log_id ?? 0 };
    },
    setSync(record: MachineSyncRecord): void {
      sql.run(
        `INSERT INTO machine_sync (machine_id, epoch, applied_log_id) VALUES (?, ?, ?)
         ON CONFLICT (machine_id) DO UPDATE SET epoch = excluded.epoch, applied_log_id = excluded.applied_log_id`,
        record.machineId,
        record.epoch,
        record.appliedLogId,
      );
    },

    edit(id: string): HeldEditRecord | null {
      const row = sql.get<EditRow>("SELECT * FROM held_edits WHERE id = ?", id);
      return row ? toEdit(row) : null;
    },
    /** A machine's edits in the order they were made. */
    editsForMachine(machineId: string): HeldEditRecord[] {
      return sql.all<EditRow>("SELECT * FROM held_edits WHERE machine_id = ? ORDER BY seq", machineId).map(toEdit);
    },
    editsForTask(taskId: string): HeldEditRecord[] {
      return sql.all<EditRow>("SELECT * FROM held_edits WHERE task_id = ? ORDER BY seq", taskId).map(toEdit);
    },
    /** How many edits wait per task: those the machine hasn't answered yet. */
    waitingFor(taskIds: readonly string[]): Map<string, number> {
      const rows = sql.all<{ task_id: string; n: number }>(
        `SELECT task_id, COUNT(*) AS n FROM held_edits
         WHERE task_id IN (SELECT value FROM json_each(?)) AND settled_head IS NULL GROUP BY task_id`,
        jsonList(taskIds),
      );
      return new Map(rows.map((r) => [r.task_id, r.n]));
    },
    insertEdit(edit: Omit<HeldEditRecord, "seq">): void {
      sql.run(
        `INSERT INTO held_edits (id, task_id, machine_id, op, args_json, ids_json, references_json, event_ids_json,
           settled_head, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        edit.id,
        edit.taskId,
        edit.machineId,
        edit.op,
        JSON.stringify(edit.args),
        JSON.stringify(edit.ids),
        JSON.stringify(edit.references),
        JSON.stringify(edit.eventIds),
        edit.settledHead,
        edit.createdAt,
      );
    },
    settleEdit(id: string, head: number): void {
      sql.run("UPDATE held_edits SET settled_head = ? WHERE id = ?", head, id);
    },
    deleteEdit(id: string): void {
      sql.run("DELETE FROM held_edits WHERE id = ?", id);
    },
    deleteEvents(ids: readonly number[]): void {
      sql.run("DELETE FROM task_events WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids));
    },
  };
}
