import {
  CHANGE_LOG_FORMAT,
  taskLabel,
  type AutopilotRun,
  type NotifyInput,
  type ChangesResponse,
  type CopiedProject,
  type CopiedUsage,
  type TaskState,
  type HandOverRequest,
  type HeldEditRequest,
  type HeldEditResult,
  type LogPosition,
  type Project,
  type TaskReference,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import type { WorkingCopyRole } from "../db/repos/workingCopies.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError } from "../errors.ts";
import { positionAmong, type Core, type Effects, type WriteMarks } from "./core.ts";
import {
  blankTask,
  copiedEvent,
  identityOf,
  readTaskState,
  referenceOf,
  referencedIds,
  writeTaskState,
} from "./taskState.ts";
import type { ProjectsService, Services } from "./types.ts";

// A runner's side of held tasks (docs/features/remote-machines.md#held-tasks): the working copies it holds for its
// board, and the ordered log of every change to them. A held task lives in the runner's own tables under the
// board's ids, so every service and tool works on it as on a board; `working_copies` says which rows those are.

/** Entries in one answer to the board; it asks again for the rest. */
const ENTRIES_PER_READ = 200;
/** How long a dealt-with edit is remembered, in case the board sends it again. */
const EDIT_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;
/** Who wrote what a hand-over brings: the board. */
const BOARD_ACTOR = "board";

export interface WorkingCopiesService {
  /** What a task row is on this runner; null on a board, or for a task this database doesn't have. */
  role(taskId: string): WorkingCopyRole | null;
  /** The runner's project for one of the board's, or null when it has none yet (see `adoptProject`). */
  projectFor(project: CopiedProject): Project | null;
  /** The board's id for one of this runner's projects; null for one the board hasn't named. */
  boardProjectId(projectId: string): string | null;
  /** Makes the runner's project for one of the board's, at the folder it was cloned to (none for a project with no repository). */
  adoptProject(project: CopiedProject, workspaceRoot: string | null): Project;
  /** Takes a task from the board: its working copy, with the tasks it points at as references. Sending it again refreshes it. */
  accept(request: HandOverRequest, project: Project): LogPosition;
  /** Gives a task back: its last state goes in the log and the copy is dropped. Releasing one not held does nothing. */
  release(taskId: string): LogPosition;
  /**
   * What the board hasn't applied: the entries after `after`. `epoch` is the log the board's position belongs to;
   * when it isn't this runner's (its database was replaced), the answer starts from the beginning. Entries the board
   * has applied are dropped.
   */
  changes(after: number, epoch: string | undefined): Omit<ChangesResponse, "requests">;
  /** Applies an edit the board made to a held task. One sent twice is applied once. */
  applyEdit(request: HeldEditRequest): HeldEditResult;
  /**
   * Refuses an edit this runner can't read (a newer board's), logging the task's state so the board puts back what
   * it showed early.
   */
  refuseEdit(id: string, taskId: string, reason: string): HeldEditResult;
  /** Keeps the prefix the board gave this machine and the highest number the board has seen under it. */
  setNumbering(prefix: string, counter: number): void;
  /** A number the board gave out for the next task made here. */
  offerNumber(number: number): void;
  /**
   * The number for a task made here: one the board gave out when there is one, else the machine's prefix and its
   * own counter. Throws CONFLICT on a runner no board has connected to yet.
   */
  nextNumber(): { prefix: string; number: number };
  /** Calls `listener` after each write that added to the log. */
  onAppended(listener: () => void): void;
  /**
   * Logs a run of this machine's own Autopilot as it now stands, inside the write that changed it, under the board's
   * id for its project. Nothing on a board.
   */
  logRun(run: AutopilotRun): void;
  /**
   * Brings the tasks held ones point at up to date with the board, those this runner already has as references;
   * one that changed column is marked changed, so the engine looks at what it blocks.
   */
  refreshReferences(references: readonly TaskReference[]): void;
  /** Logs a notification raised here, for the board's inbox. Nothing on a board. */
  logNotice(input: NotifyInput): void;
  /** The board's id for one of this runner's projects, else null (a project made here the board hasn't named). */
  boardProjectOf(projectId: string | null): string | null;
}

export function createWorkingCopiesService(
  core: Core,
  deps: {
    projects: ProjectsService;
    /** The service layer, for applying the board's edits; read lazily, since this is part of it. */
    services: () => Services;
    /** `host/owner/repo` and the URL of a folder's `origin`, read on the spot; null without one. */
    readRemote: (workspaceRoot: string) => { remote: string; remoteUrl: string } | null;
    /** A runner logs changes; a board keeps this service only to answer `role`. */
    logs: boolean;
    /** What a task's sessions and runs on this machine have used, sent with its changes. */
    usageOf: (taskId: string) => CopiedUsage[];
  },
): WorkingCopiesService {
  const { repos } = core;
  const copies = repos.workingCopies;
  const listeners: Array<() => void> = [];
  /** Tasks whose next write logs an entry even when nothing changed: the answer to an edit. */
  const forced = new Set<string>();
  const numberPool: number[] = [];
  let appended = false;

  const epoch = (): string => {
    const stored = copies.state("epoch");
    if (stored) return stored;
    const fresh = randomUUID();
    core.write(() => copies.setState("epoch", fresh));
    return fresh;
  };

  const append = (kind: string, taskId: string, payload: unknown): void => {
    copies.append({
      version: CHANGE_LOG_FORMAT,
      kind,
      taskId,
      at: core.now().toISOString(),
      payload,
    });
    appended = true;
  };

  /** The board's name for one of this runner's projects: its own id for it when it gave one, and the repository. */
  const copiedProject = (projectId: string): CopiedProject => {
    const project = deps.projects.get(projectId);
    let mapping = copies.project(projectId);
    if (!mapping) {
      // A project made here (an agent's own folder): the board finds its own by the repository.
      const found = project.workspaceRoot ? deps.readRemote(project.workspaceRoot) : null;
      mapping = {
        projectId,
        boardId: null,
        remote: found?.remote ?? null,
        remoteUrl: found?.remoteUrl ?? null,
      };
      copies.setProject(mapping);
    }
    return {
      id: mapping.boardId ?? projectId,
      title: project.title,
      remote: mapping.remote,
      remoteUrl: mapping.remoteUrl,
    };
  };

  /** A held task's state as this runner logs it: with what it read of the task's pull requests. */
  const stateOf = (task: TaskRecord): TaskState => readTaskState(repos, task, { prSnapshots: true });

  /** What was last logged of a task, as one text: a write that leaves it the same logs nothing. */
  const loggedText = (state: TaskState, usage: readonly CopiedUsage[]): string =>
    `${JSON.stringify(state)}\n${JSON.stringify(usage)}`;

  /** Logs what this write changed on held tasks, and takes a task made here as a held one. */
  const logChanges = (marks: WriteMarks): void => {
    const roles = copies.forTasks(marks.tasks);
    for (const id of marks.tasks) {
      const copy = roles.get(id);
      if (copy?.role === "reference") continue;
      const task = repos.tasks.getAny(id);
      if (!task) continue;
      const state = stateOf(task);
      const usage = deps.usageOf(id);
      const json = loggedText(state, usage);
      const events = repos.events.after(id, copy?.lastEventId ?? 0);
      if (!copy) {
        const references = repos.tasks.getMany(referencedIds(task, state)).map(referenceOf);
        append("created", id, {
          identity: identityOf(task),
          project: copiedProject(task.projectId),
          epicId: task.parentId,
          state,
          events: events.map(copiedEvent),
          usage,
          references,
        });
      } else if (json !== copy.loggedState || events.length > 0 || forced.has(id)) {
        append("state", id, { state, events: events.map(copiedEvent), usage });
      } else continue;
      forced.delete(id);
      copies.upsert({
        taskId: id,
        role: "held",
        lastEventId: events.at(-1)?.id ?? copy?.lastEventId ?? 0,
        loggedState: json,
        createdAt: copy?.createdAt ?? core.now().toISOString(),
      });
    }
  };

  if (deps.logs) {
    core.beforeCommit(logChanges);
    core.afterCommit(() => {
      if (!appended) return;
      appended = false;
      for (const listener of listeners) listener();
    });
  }

  /** Keeps the tasks a held one points at, as rows nothing here changes. A task held here is left as it is. */
  const upsertReferences = (references: readonly TaskReference[], projectId: string): void => {
    const now = core.now().toISOString();
    for (const ref of references) {
      const existing = repos.tasks.getAny(ref.id);
      const role = copies.get(ref.id)?.role;
      if (existing && role !== "reference") continue;
      const shown = {
        title: ref.title,
        status: ref.status,
        archivedAt: ref.archived ? (existing?.archivedAt ?? now) : null,
        delivery: ref.delivery ?? null,
        integrationBranch: ref.integrationBranch ?? null,
        updatedAt: now,
      };
      if (existing) repos.tasks.update({ ...existing, ...shown });
      else {
        repos.tasks.insert({
          ...blankTask(ref.id, ref.number, ref.numberPrefix, projectId, now),
          kind: ref.kind,
          ...shown,
          position: positionAmong(repos.tasks.lane(projectId, ref.status), {}),
        });
      }
      copies.upsert({
        taskId: ref.id,
        role: "reference",
        lastEventId: 0,
        loggedState: null,
        createdAt: now,
      });
    }
  };

  /** Drops the references no held task points at any more. */
  const dropLooseReferences = (fx: Effects): void => {
    for (const id of copies.looseReferences()) {
      repos.tasks.delete(id);
      fx.taskDeleted(id);
    }
  };

  /** The service call an edit names, with its arguments as the board made it. */
  const dispatch = (request: HeldEditRequest): void => {
    const { tasks, plans, links, attention, reviews } = deps.services();
    // The arguments were this version's own on the board; an edit this runner can't make sense of throws and is
    // refused like any other.
    const call = (fn: (...args: never[]) => unknown): void => void fn(...(request.args as never[]));
    switch (request.op) {
      case "tasks.update":
        return call(tasks.update.bind(tasks));
      case "tasks.move":
        return call(tasks.move.bind(tasks));
      case "tasks.close":
        return call(tasks.close.bind(tasks));
      case "tasks.addNote":
        return call(tasks.addNote.bind(tasks));
      case "plans.setPlan":
        return call(plans.setPlan.bind(plans));
      case "plans.updatePlan":
        return call(plans.updatePlan.bind(plans));
      case "plans.addPhase":
        return call(plans.addPhase.bind(plans));
      case "plans.updatePhase":
        return call(plans.updatePhase.bind(plans));
      case "plans.deletePhase":
        return call(plans.deletePhase.bind(plans));
      case "plans.addSteps":
        return call(plans.addSteps.bind(plans));
      case "plans.updateStep":
        return call(plans.updateStep.bind(plans));
      case "plans.moveStep":
        return call(plans.moveStep.bind(plans));
      case "plans.deleteStep":
        return call(plans.deleteStep.bind(plans));
      case "links.add":
        return call(links.add.bind(links));
      case "links.remove":
        return call(links.remove.bind(links));
      case "links.unlink":
        return call(links.unlink.bind(links));
      case "attention.request":
        return call(attention.request.bind(attention));
      case "attention.clear":
        return call(attention.clear.bind(attention));
      case "reviews.openRound":
        return call(reviews.openRound.bind(reviews));
      case "reviews.submit":
        return call(reviews.submit.bind(reviews));
      case "reviews.resolveFinding":
        return call(reviews.resolveFinding.bind(reviews));
    }
  };

  /** Remembers an edit's outcome inside the write that made it, so one sent again gets the same answer. */
  const recordEdit = (id: string, applied: boolean, error: string | null): HeldEditResult => {
    // The entry this write logs is the first after the head as it stands: the one that carries the outcome.
    const result = { applied, error, head: copies.head() + 1 };
    copies.recordEdit({ id, ...result }, core.now().toISOString());
    copies.pruneEdits(new Date(core.now().getTime() - EDIT_MEMORY_MS).toISOString());
    return result;
  };

  /** Refuses an edit, logging the task's state all the same when it is held, so the board puts back what it showed. */
  const refuse = (id: string, taskId: string, reason: string): HeldEditResult => {
    const prior = copies.appliedEdit(id);
    if (prior) return { applied: prior.applied, error: prior.error, head: prior.head };
    const held = copies.get(taskId)?.role === "held";
    if (held) forced.add(taskId);
    return core.write((fx) => {
      if (held) fx.detail(taskId);
      const result = recordEdit(id, false, reason);
      // Nothing is logged for a task not held here: the outcome is at the head as it stands.
      return held ? result : { ...result, head: copies.head() };
    });
  };

  return {
    role: (taskId) => copies.get(taskId)?.role ?? null,

    projectFor(project) {
      const mapping = copies.projectFor(project.id, project.remote);
      if (!mapping) return null;
      try {
        return deps.projects.get(mapping.projectId);
      } catch {
        return null;
      }
    },

    boardProjectId: (projectId) => copies.project(projectId)?.boardId ?? null,

    adoptProject(project, workspaceRoot) {
      return core.write(() => {
        const made = workspaceRoot
          ? deps.projects.resolveOrCreate({ workspacePath: workspaceRoot }).project
          : deps.projects.create({ title: project.title });
        const named = made.title === project.title ? made : deps.projects.update(made.id, { title: project.title });
        copies.setProject({
          projectId: named.id,
          boardId: project.id,
          remote: project.remote,
          remoteUrl: project.remoteUrl,
        });
        return named;
      });
    },

    accept(request, project) {
      return core.write((fx) => {
        const { identity, state } = request;
        const now = core.now().toISOString();
        upsertReferences(request.references, project.id);
        const epic = request.epicId ? repos.tasks.getAny(request.epicId) : null;
        const existing = repos.tasks.getAny(identity.id);
        const base: TaskRecord = existing ?? {
          ...blankTask(identity.id, identity.number, identity.numberPrefix, project.id, now),
          kind: identity.kind,
          createdBy: identity.createdBy,
          createdAt: identity.createdAt,
          title: state.task.title,
          status: state.task.status,
          position: positionAmong(repos.tasks.lane(project.id, state.task.status), {}),
        };
        if (!existing) repos.tasks.insert(base);
        const saved = writeTaskState(
          repos,
          {
            ...base,
            projectId: project.id,
            parentId: epic?.kind === "epic" ? epic.id : null,
            deletedAt: null,
          },
          state,
          { blocks: true, actor: BOARD_ACTOR },
        );
        // The board's word on the task, activity included: a copy left here from a hold the board ended by force
        // is replaced, not added to.
        if (existing) repos.events.deleteForTask(saved.id);
        for (const event of request.events) {
          repos.events.append(saved.id, event.at, event.actor, event.type, event.payload);
        }
        copies.upsert({
          taskId: saved.id,
          role: "held",
          lastEventId: repos.events.lastId(),
          loggedState: loggedText(stateOf(saved), deps.usageOf(saved.id)),
          createdAt: now,
        });
        fx.task(saved.id);
        return { head: copies.head() };
      });
    },

    release(taskId) {
      core.write((fx) => {
        const copy = copies.get(taskId);
        const task = repos.tasks.getAny(taskId);
        if (copy?.role !== "held" || !task) return;
        const events = repos.events.after(taskId, copy.lastEventId);
        append("released", taskId, {
          state: stateOf(task),
          events: events.map(copiedEvent),
          usage: deps.usageOf(taskId),
        });
        // Another held task may still point at it (its blocker, say): then it stays, as a reference.
        copies.upsert({ ...copy, role: "reference", loggedState: null });
        dropLooseReferences(fx);
        if (repos.tasks.getAny(taskId)) fx.task(taskId);
      });
      return { head: copies.head() };
    },

    changes(after, boardEpoch) {
      const own = epoch();
      const from = boardEpoch === own ? after : 0;
      if (from > 0) core.write(() => copies.dropThrough(from));
      return {
        epoch: own,
        head: copies.head(),
        entries: copies.entriesAfter(from, ENTRIES_PER_READ),
        held: copies.heldIds(),
      };
    },

    refuseEdit: (id, taskId, reason) => refuse(id, taskId, reason),

    applyEdit(request) {
      const prior = copies.appliedEdit(request.id);
      if (prior) return { applied: prior.applied, error: prior.error, head: prior.head };
      const record = (applied: boolean, error: string | null) => recordEdit(request.id, applied, error);
      if (copies.get(request.taskId)?.role !== "held") {
        return refuse(request.id, request.taskId, "The machine no longer holds the task");
      }
      forced.add(request.taskId);
      try {
        return core.write((fx) => {
          const task = repos.tasks.getAny(request.taskId)!;
          upsertReferences(request.references, task.projectId);
          core.withIds(request.ids, () => dispatch(request));
          fx.detail(request.taskId);
          return record(true, null);
        });
      } catch (error) {
        // Refused as the task stands here (the agent got there first, say). The state is logged all the same, so
        // the board puts back what it showed.
        const message = error instanceof AppError ? error.message : "The machine couldn't apply the edit";
        if (!(error instanceof AppError)) console.error("[working-copies] edit failed", error);
        return refuse(request.id, request.taskId, message);
      }
    },

    setNumbering(prefix, counter) {
      if (copies.state("prefix") === prefix && repos.tasks.machineCounter(prefix) >= counter) return;
      core.write(() => {
        copies.setState("prefix", prefix);
        repos.tasks.raiseMachineCounter(prefix, counter);
      });
    },

    offerNumber: (number) => void numberPool.push(number),

    nextNumber() {
      const offered = numberPool.shift();
      if (offered !== undefined) return { prefix: "", number: offered };
      const prefix = copies.state("prefix");
      if (!prefix) {
        throw new AppError(
          "CONFLICT",
          "This machine isn't connected to a board yet, so it has no numbers to give a new task. Connect it first.",
        );
      }
      return { prefix, number: repos.tasks.nextMachineNumber(prefix) };
    },

    onAppended: (listener) => void listeners.push(listener),

    logRun(run) {
      if (!deps.logs) return;
      const { machine: _machine, ...own } = run;
      core.write(() =>
        append("run", run.taskId ?? "", {
          run: {
            ...own,
            projectId: run.projectId ? (copies.project(run.projectId)?.boardId ?? null) : null,
          },
        }),
      );
    },

    refreshReferences(references) {
      core.write((fx) => {
        for (const ref of references) {
          if (copies.get(ref.id)?.role !== "reference") continue;
          const before = repos.tasks.getAny(ref.id);
          if (!before) continue;
          upsertReferences([ref], before.projectId);
          if (before.status !== ref.status || before.title !== ref.title) fx.task(ref.id);
          // The tasks it blocks see their blocker change.
          for (const r of repos.relations.allFor([ref.id])) if (r.blockerId === ref.id) fx.task(r.blockedId);
        }
      });
    },

    logNotice(input) {
      if (!deps.logs) return;
      const taskId = input.taskId ?? null;
      // Only what the board has: a notification about a task made here and not yet on the board, or about nothing
      // held, still goes, and the board shows it without a task.
      core.write(() =>
        append("notice", taskId ?? "", {
          notice: {
            kind: input.kind,
            taskId,
            title: input.title,
            body: input.body,
            dedupeKey: input.dedupeKey,
          },
        }),
      );
    },

    boardProjectOf: (projectId) => (projectId ? (copies.project(projectId)?.boardId ?? null) : null),
  };
}

/** The sentence a runner refuses a change to a task it only refers to with. */
export const notHeldHere = (task: Pick<TaskRecord, "number" | "numberPrefix">): AppError =>
  new AppError(
    "CONFLICT",
    `${taskLabel(task)} isn't held by this machine, so it can't be changed here; only the tasks handed to it can.`,
  );
