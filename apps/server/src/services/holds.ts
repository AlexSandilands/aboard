import {
  ChangeLogFormatError,
  readChangeLogEntry,
  taskLabel,
  taskNumberValue,
  type ChangeLogEntry,
  type ChangesResponse,
  type CopiedEvent,
  type AutopilotRun,
  type CopiedUsage,
  type HandOverRequest,
  type NotifyInput,
  type RunMachine,
  type HeldEditResult,
  type TaskDetail,
  type TaskReference,
  type TaskState,
} from "@repo/contracts";
import type { HeldEditRecord, HoldRecord } from "../db/repos/holds.ts";
import type { MachineRecord } from "../db/repos/machines.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound } from "../errors.ts";
import { positionAmong, type Core, type Effects } from "./core.ts";
import { syncEpicStatus } from "./tasks.ts";
import {
  blankTask,
  copiedEvent,
  identityOf,
  readTaskState,
  referenceOf,
  referencedIds,
  writeTaskState,
} from "./taskState.ts";
import type { ProjectsService } from "./types.ts";

// A board's side of held tasks (docs/features/remote-machines.md#held-tasks): which machine holds which task, how
// far each machine's change log has been applied, and the edits made here that a machine hasn't taken yet.

/** How much of a task's activity goes with it, so an agent on the machine reads the same handover notes. */
const HANDOVER_EVENTS = 50;
/** Who refuses an edit in the activity log: the board, on the machine's word. */
const BOARD_ACTOR = "board";

/** Where the board is in a machine's log, and what the machine numbers tasks with. */
export interface MachinePosition {
  epoch: string | null;
  appliedLogId: number;
  prefix: string;
  /** The highest number seen under the prefix. */
  counter: number;
}

export interface ApplyResult {
  /** Entries applied by this call. */
  applied: number;
  appliedLogId: number;
  /** Tasks the machine says it holds that this board didn't hand it: it is told to drop them. */
  stray: string[];
  /** Set when an entry couldn't be read; everything before it was applied and the position stays there. */
  error: string | null;
  /** The machine has entries this answer didn't carry: read again. */
  more: boolean;
}

export interface HoldsService {
  get(taskId: string): HoldRecord | null;
  forMachine(machineId: string): HoldRecord[];
  /**
   * What to send a machine to hand it the task. Throws VALIDATION for a task that can't be handed over (an epic, a
   * manual or archived task) and CONFLICT for one already held. `remote` is the project's repository, read by the
   * caller.
   */
  prepare(taskId: string, machineId: string, remote: { remote: string; remoteUrl: string } | null): HandOverRequest;
  /**
   * Records that the machine took the task, at `head` of its log: what it logged about the task before that is from
   * an earlier hold. Throws CONFLICT when the task is no longer as `sent` (the state `prepare` read): the machine's
   * copy is then stale, and the caller takes it back.
   */
  confirm(taskId: string, machineId: string, sent: TaskState, head: number, actor: string): TaskDetail;
  /** Takes a task back without its machine. What the machine changed and the board hasn't applied is lost. */
  forceRelease(taskId: string, actor: string): void;
  position(machineId: string): MachinePosition;
  /**
   * Applies a machine's log entries in order, each once, in one write. `projectByRemote` maps a repository to this
   * board's project for it, for tasks made on the machine in a project the board didn't name.
   */
  apply(
    machineId: string,
    response: Pick<ChangesResponse, "epoch" | "head" | "entries" | "held">,
    projectByRemote?: ReadonlyMap<string, string>,
  ): ApplyResult;
  /** The machine's edits that haven't reached it, in the order they were made. */
  pendingEdits(machineId: string): HeldEditRecord[];
  /** The tasks the machine's held ones point at that it doesn't hold, as they stand here. */
  referencesFor(machineId: string): TaskReference[];
  /** Records the machine's answer to an edit: taken, or refused as the task stands there. */
  settleEdit(editId: string, result: HeldEditResult): void;
  /** The next of the board's own task numbers, for a task a machine is making. */
  allocateNumber(): number;
  /** Throws CONFLICT when one of the tasks is held, since `what` can't be done to it while a machine orders it. */
  assertNotHeld(taskIds: readonly string[], what: string): void;
}

export function createHoldsService(
  core: Core,
  deps: {
    projects: ProjectsService;
    detail: (id: string) => TaskDetail;
    /** Keeps what a machine read of a held task's token usage, inside the write that applies its entry. */
    keepUsage: (machineId: string, taskId: string, rows: readonly CopiedUsage[]) => void;
    /** Keeps a run the machine's own Autopilot made, inside the write that applies its entry. */
    keepRun?: (run: AutopilotRun, machine: RunMachine) => void;
    /** Raises a notification the machine raised, by this board's switches. */
    notify?: (input: NotifyInput) => void;
  },
): HoldsService {
  const { repos } = core;
  const holds = repos.holds;

  const machineOf = (id: string): MachineRecord => {
    const machine = repos.machines.get(id);
    if (!machine) throw notFound("Machine", id);
    return machine;
  };
  const taskOf = (id: string): TaskRecord => {
    const task = repos.tasks.get(id);
    if (!task) throw notFound("Task", id);
    return task;
  };

  /** Ends a hold inside a write, saying why in the task's activity. Its waiting edits become the task's own state. */
  const dropHold = (
    taskId: string,
    machine: MachineRecord,
    actor: string,
    why: Record<string, unknown>,
    fx: Effects,
  ): void => {
    for (const edit of holds.editsForTask(taskId)) holds.deleteEdit(edit.id);
    if (!holds.delete(taskId)) return;
    fx.log(taskId, actor, "released", { machine: machine.name, ...why });
  };

  /** Removes an edit whose outcome the board now has, with the activity it wrote when it showed the edit early. */
  const finishEdit = (edit: HeldEditRecord): void => {
    holds.deleteEvents(edit.eventIds);
    holds.deleteEdit(edit.id);
  };

  /** Writes a machine's state of a task over the board's, with the activity the machine logged. */
  const applyState = (
    task: TaskRecord,
    payload: {
      state: TaskState;
      events: CopiedEvent[];
      usage?: CopiedUsage[] | undefined;
    },
    entryId: number,
    machine: MachineRecord,
    fx: Effects,
  ): void => {
    const statusChanged = payload.state.task.status !== task.status;
    const lane = repos.tasks.lane(task.projectId, payload.state.task.status).filter((t) => t.id !== task.id);
    // The lane is the board's: a task that changed column goes to the end of its new one.
    const base = statusChanged ? { ...task, position: positionAmong(lane, {}) } : task;
    const saved = writeTaskState(repos, base, payload.state, {
      actor: machine.name,
    });
    for (const edit of holds.editsForTask(task.id)) {
      if (edit.settledHead !== null && edit.settledHead <= entryId) finishEdit(edit);
    }
    if (payload.usage) deps.keepUsage(machine.id, task.id, payload.usage);
    for (const event of payload.events) fx.replay(task.id, event);
    fx.task(task.id);
    if (statusChanged && task.parentId) syncEpicStatus(repos, task.parentId, machine.name, fx);
    for (const id of new Set([task.resolvedByTaskId, saved.resolvedByTaskId])) {
      if (id && task.resolvedByTaskId !== saved.resolvedByTaskId) fx.detail(id);
    }
  };

  /** A task made on the machine: the board's row for it, held by that machine from the start. */
  const applyCreated = (
    entry: Extract<ChangeLogEntry, { kind: "created" }>,
    machine: MachineRecord,
    projectByRemote: ReadonlyMap<string, string>,
    fx: Effects,
  ): void => {
    const { identity, project: copied, state } = entry.payload;
    const byRemote = copied.remote ? projectByRemote.get(copied.remote) : undefined;
    // The board's own id for the project, else the same repository, else General: never a lane made unasked.
    const project =
      repos.projects.get(copied.id) ?? (byRemote ? repos.projects.get(byRemote) : null) ?? deps.projects.general();
    const at = core.now().toISOString();
    let { number } = identity;
    const prefix = identity.numberPrefix;
    const taken = repos.tasks.byNumberAny(number, prefix);
    // Never expected: the board gave out the plain numbers and each prefix has one counter. A clash keeps the task.
    if (taken) number = prefix ? repos.tasks.nextMachineNumber(prefix) : repos.tasks.nextNumber();
    if (prefix) {
      repos.tasks.raiseMachineCounter(prefix, number);
      if (!machine.prefixFixed) repos.machines.update({ ...machine, prefixFixed: true });
    }
    const epic = entry.payload.epicId ? repos.tasks.get(entry.payload.epicId) : null;
    const parentId = epic?.kind === "epic" && epic.projectId === project.id && !epic.archivedAt ? epic.id : null;
    const task: TaskRecord = {
      ...blankTask(identity.id, number, prefix, project.id, at),
      kind: identity.kind,
      parentId,
      createdBy: identity.createdBy,
      createdAt: identity.createdAt,
      title: state.task.title,
      status: state.task.status,
      position: positionAmong(repos.tasks.lane(project.id, state.task.status), {}),
    };
    repos.tasks.insert(task);
    holds.insert({
      taskId: task.id,
      machineId: machine.id,
      heldAt: at,
      afterLogId: 0,
    });
    applyState(task, entry.payload, entry.id, machine, fx);
    if (taken)
      fx.log(task.id, BOARD_ACTOR, "renumbered", {
        from: `${prefix}${identity.number}`,
        machine: machine.name,
      });
    if (parentId) {
      fx.log(parentId, machine.name, "child_added", {
        task: taskNumberValue(task),
        title: task.title,
      });
      syncEpicStatus(repos, parentId, machine.name, fx);
    }
  };

  const applyEntry = (
    entry: ChangeLogEntry,
    machine: MachineRecord,
    projectByRemote: ReadonlyMap<string, string>,
    fx: Effects,
  ): void => {
    // A machine's runs and notifications are history and news, not the task's state: whoever holds the task now,
    // and whether or not it is still held, they are the board's to keep.
    if (entry.kind === "run")
      return deps.keepRun?.(entry.payload.run, {
        id: machine.id,
        name: machine.name,
      });
    if (entry.kind === "notice") {
      const { notice } = entry.payload;
      const taskId = notice.taskId && repos.tasks.get(notice.taskId) ? notice.taskId : null;
      return deps.notify?.({ ...notice, taskId });
    }
    const task = repos.tasks.getAny(entry.taskId);
    const hold = holds.get(entry.taskId);
    // Entries from before this hold began (the task was taken back by force, then handed over again) are skipped
    // like those of a task the machine doesn't hold: what they say was given up.
    const held = hold?.machineId === machine.id && entry.id > hold.afterLogId;
    if (entry.kind === "created" && !task) return applyCreated(entry, machine, projectByRemote, fx);
    // A task this board doesn't have the machine holding (taken back by force, say): its changes aren't the board's.
    if (!task || !held) return;
    applyState(task, entry.payload, entry.id, machine, fx);
    if (entry.kind === "released") dropHold(task.id, machine, machine.name, {}, fx);
  };

  return {
    get: (taskId) => holds.get(taskId),
    forMachine: (machineId) => holds.forMachine(machineId),

    prepare(taskId, machineId, remote) {
      const task = taskOf(taskId);
      const machine = machineOf(machineId);
      const label = taskLabel(task);
      if (task.kind === "epic") {
        throw new AppError("VALIDATION", `${label} is an epic; hand over its tasks, which are what an agent works on`);
      }
      if (task.manual) throw new AppError("VALIDATION", `${label} is a manual task, which no machine works on`);
      if (task.archivedAt !== null) throw new AppError("VALIDATION", `${label} is archived; unarchive it first`);
      const hold = holds.get(taskId);
      if (hold) {
        const holder = repos.machines.get(hold.machineId)?.name ?? "a machine";
        throw new AppError("CONFLICT", `${label} is already held by ${holder}; take it back first`);
      }
      const project = deps.projects.get(task.projectId);
      const state = readTaskState(repos, task);
      void machine;
      return {
        identity: identityOf(task),
        project: {
          id: project.id,
          title: project.title,
          remote: remote?.remote ?? null,
          remoteUrl: remote?.remoteUrl ?? null,
        },
        epicId: task.parentId,
        state,
        events: repos.events.recent(taskId, HANDOVER_EVENTS).map(copiedEvent),
        references: repos.tasks.getMany(referencedIds(task, state)).map(referenceOf),
      };
    },

    confirm(taskId, machineId, sent, head, actor) {
      core.write((fx) => {
        const task = taskOf(taskId);
        const machine = machineOf(machineId);
        if (holds.get(taskId)) throw new AppError("CONFLICT", `${taskLabel(task)} is already held`);
        // The whole state, not only when the task was last touched: a link or a label added meanwhile doesn't
        // stamp the task, and the machine's first entry would take it away again.
        if (JSON.stringify(readTaskState(repos, task)) !== JSON.stringify(sent)) {
          throw new AppError("CONFLICT", `${taskLabel(task)} changed while it was being handed over; try again`);
        }
        holds.insert({
          taskId,
          machineId,
          heldAt: core.now().toISOString(),
          afterLogId: head,
        });
        fx.log(taskId, actor, "handed_over", { machine: machine.name });
      });
      return deps.detail(taskId);
    },

    forceRelease(taskId, actor) {
      core.write((fx) => {
        const task = taskOf(taskId);
        const hold = holds.get(taskId);
        if (!hold) throw new AppError("VALIDATION", `${taskLabel(task)} isn't held by a machine`);
        dropHold(taskId, machineOf(hold.machineId), actor, { forced: true }, fx);
      });
    },

    position(machineId) {
      const machine = machineOf(machineId);
      const sync = holds.sync(machineId);
      return {
        epoch: sync.epoch,
        appliedLogId: sync.appliedLogId,
        prefix: machine.prefix,
        counter: repos.tasks.machineCounter(machine.prefix),
      };
    },

    apply(machineId, response, projectByRemote = new Map()) {
      return core.write((fx) => {
        const machine = machineOf(machineId);
        const sync = holds.sync(machineId);
        let cursor = sync.appliedLogId;
        if (sync.epoch !== null && sync.epoch !== response.epoch) {
          // Another log: the machine's database was replaced, and its ids start again. The copies it had are gone.
          cursor = 0;
          holds.resetLogPositions(machineId);
          for (const hold of holds.forMachine(machineId)) {
            if (!response.held.includes(hold.taskId)) dropHold(hold.taskId, machine, BOARD_ACTOR, { lost: true }, fx);
          }
        }
        let applied = 0;
        let error: string | null = null;
        for (const stored of response.entries) {
          // Applied before: a connection that dropped after the answer left sends the same entries again.
          if (stored.id <= cursor) continue;
          let entry: ChangeLogEntry;
          try {
            entry = readChangeLogEntry(stored);
          } catch (cause) {
            if (!(cause instanceof ChangeLogFormatError)) throw cause;
            error = cause.message;
            break;
          }
          applyEntry(entry, machine, projectByRemote, fx);
          cursor = stored.id;
          applied += 1;
        }
        holds.setSync({
          machineId,
          epoch: response.epoch,
          appliedLogId: cursor,
        });
        // Only once the whole log is read: a task made on the machine has no hold here until its `created` entry is
        // applied, and that entry may be past what this answer carried or past one that couldn't be read.
        const caughtUp = error === null && cursor >= response.head;
        const stray = caughtUp ? response.held.filter((id) => holds.get(id)?.machineId !== machineId) : [];
        return {
          applied,
          appliedLogId: cursor,
          stray,
          error,
          more: error === null && cursor < response.head,
        };
      });
    },

    pendingEdits: (machineId) => holds.editsForMachine(machineId).filter((e) => e.settledHead === null),

    referencesFor(machineId) {
      const held = holds.forMachine(machineId).map((h) => h.taskId);
      const heldSet = new Set(held);
      const ids = new Set<string>();
      for (const task of repos.tasks.getMany(held)) {
        for (const id of referencedIds(task, readTaskState(repos, task))) if (!heldSet.has(id)) ids.add(id);
      }
      return repos.tasks
        .getMany([...ids])
        .map(referenceOf)
        .toSorted((a, b) => a.id.localeCompare(b.id));
    },

    settleEdit(editId, result) {
      core.write((fx) => {
        const edit = holds.edit(editId);
        if (!edit) return;
        if (!result.applied) {
          // What the board showed early is taken back; the machine's next entry puts the task as it is there.
          finishEdit(edit);
          fx.log(edit.taskId, BOARD_ACTOR, "edit_refused", {
            edit: edit.op,
            reason: result.error ?? "",
          });
          return;
        }
        // The entry with the outcome may have been applied already, on the poll that was waiting meanwhile.
        if (result.head <= holds.sync(edit.machineId).appliedLogId) finishEdit(edit);
        else holds.settleEdit(editId, result.head);
        fx.task(edit.taskId);
      });
    },

    allocateNumber: () => core.write(() => repos.tasks.nextNumber()),

    assertNotHeld(taskIds, what) {
      const held = holds.forTasks(taskIds);
      const first = [...held.values()][0];
      if (!first) return;
      const task = repos.tasks.getAny(first.taskId);
      const machine = repos.machines.get(first.machineId)?.name ?? "a machine";
      throw new AppError(
        "CONFLICT",
        `${task ? taskLabel(task) : "A task"} is held by ${machine}, so it can't be ${what}; take it back first`,
      );
    },
  };
}
