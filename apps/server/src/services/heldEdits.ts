import { randomUUID } from "node:crypto";
import { taskLabel, type HeldEditOp, type TaskReference } from "@repo/contracts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError } from "../errors.ts";
import type { Core } from "./core.ts";
import { referenceOf } from "./taskState.ts";
import type { Services } from "./types.ts";
import { notHeldHere } from "./workingCopies.ts";

// Edits to a task a machine holds (docs/features/remote-machines.md#edits-from-the-board). The machine orders every
// change to it, so an edit made on the board is passed on: the board applies it at once, so the card shows it, and
// queues it for the machine in the same write. The machine's answer comes back through its log, which is what the
// board keeps. Every way of changing a task goes through the service layer, so the methods are wrapped here, once.

type Method = (...args: never[]) => unknown;

interface Route {
  op: HeldEditOp;
  /** The task the call changes, from its arguments; null when it names none this database has. */
  taskOf(args: unknown[]): string | null;
  /**
   * What the machine is sent: the arguments as it should run them, and the tasks they point at. Null when the call
   * changed only what the board keeps to itself (the place in a lane, the epic).
   */
  outbound?(args: unknown[]): { args: unknown[]; references?: string[] } | null;
}

/** What only the board decides about a task, even while a machine holds it. */
const BOARD_FIELDS = ["projectId", "archived", "epicId"] as const;

export function routeHeldEdits(
  core: Core,
  services: Services,
  deps: {
    role: "board" | "runner";
    /** Called after an edit is queued, with its machine, so it is sent without waiting for the next poll. */
    onQueued: (machineId: string) => void;
  },
): void {
  const { repos } = core;
  /** Above zero while a wrapped call runs: what it calls in turn is part of the same edit. */
  let depth = 0;

  const first = (args: unknown[]): string | null => (typeof args[0] === "string" ? args[0] : null);
  const ofStep = (args: unknown[]): string | null => repos.plans.step(String(args[0]))?.taskId ?? null;
  const ofPhase = (args: unknown[]): string | null => repos.plans.phase(String(args[0]))?.taskId ?? null;
  const ofLink = (args: unknown[]): string | null => repos.links.row(String(args[0]))?.task_id ?? null;
  const resolved = (refs: unknown): string[] =>
    Array.isArray(refs) ? refs.map((ref) => services.tasks.resolveId(String(ref))) : [];

  const routes: { [K in "tasks" | "plans" | "links" | "attention"]: Record<string, Route> } = {
    tasks: {
      update: {
        op: "tasks.update",
        taskOf: first,
        outbound([id, input, actor]) {
          const sent = { ...(input as Record<string, unknown>) };
          for (const field of BOARD_FIELDS) delete sent[field];
          // By id: the machine may know a blocker under no number at all until this edit tells it.
          const add = resolved(sent.addBlockedBy);
          const remove = resolved(sent.removeBlockedBy);
          if (sent.addBlockedBy) sent.addBlockedBy = add;
          if (sent.removeBlockedBy) sent.removeBlockedBy = remove;
          if (Object.values(sent).every((value) => value === undefined)) return null;
          return { args: [id, sent, actor], references: [...add, ...remove] };
        },
      },
      move: {
        op: "tasks.move",
        taskOf: first,
        outbound([id, input, actor, because]) {
          const { status } = input as { status?: string };
          // Where a card sits in its lane is the board's alone.
          return status === undefined ? null : { args: [id, { status }, actor, because] };
        },
      },
      close: {
        op: "tasks.close",
        taskOf: first,
        outbound(args) {
          const by = (args[1] as { byTaskId?: string }).byTaskId;
          return { args, references: by ? [by] : [] };
        },
      },
      addNote: { op: "tasks.addNote", taskOf: first },
    },
    plans: {
      setPlan: { op: "plans.setPlan", taskOf: first },
      updatePlan: { op: "plans.updatePlan", taskOf: first },
      addPhase: { op: "plans.addPhase", taskOf: first },
      updatePhase: { op: "plans.updatePhase", taskOf: ofPhase },
      deletePhase: { op: "plans.deletePhase", taskOf: ofPhase },
      addSteps: { op: "plans.addSteps", taskOf: ofPhase },
      updateStep: { op: "plans.updateStep", taskOf: ofStep },
      moveStep: { op: "plans.moveStep", taskOf: ofStep },
      deleteStep: { op: "plans.deleteStep", taskOf: ofStep },
    },
    links: {
      add: { op: "links.add", taskOf: first },
      remove: { op: "links.remove", taskOf: ofLink },
      unlink: { op: "links.unlink", taskOf: first },
    },
    attention: {
      request: { op: "attention.request", taskOf: first },
      clear: { op: "attention.clear", taskOf: first },
    },
  };

  const holderName = (machineId: string): string => repos.machines.get(machineId)?.name ?? "a machine";

  /** What a board refuses on a held task outright: it would move the task out from under the machine holding it. */
  const refuseOnBoard = (route: Route, task: TaskRecord, machineId: string, args: unknown[]): void => {
    if (route.op !== "tasks.update") return;
    const input = args[1] as { projectId?: string; archived?: boolean };
    const moving = input.projectId !== undefined && input.projectId !== task.projectId;
    if (!moving && input.archived !== true) return;
    throw new AppError(
      "CONFLICT",
      `${taskLabel(task)} is held by ${holderName(machineId)}, so it can't be ` +
        `${moving ? "moved to another project" : "archived"}; take it back first`,
    );
  };

  /** What a runner refuses: a change to a task it only refers to, or to what the board keeps to itself. */
  const refuseOnRunner = (route: Route, taskId: string, args: unknown[]): void => {
    const role = repos.workingCopies.get(taskId)?.role;
    const task = repos.tasks.getAny(taskId);
    if (!task) return;
    if (role === "reference") throw notHeldHere(task);
    if (route.op !== "tasks.update") return;
    const input = args[1] as Record<string, unknown>;
    const field = BOARD_FIELDS.find((f) => input[f] !== undefined);
    if (field) {
      const what = { projectId: "project", archived: "archive state", epicId: "epic" }[field];
      throw new AppError("CONFLICT", `${taskLabel(task)}'s ${what} is changed on the board, not on this machine`);
    }
  };

  const wrap =
    (route: Route, original: Method): Method =>
    (...args: unknown[]) => {
      const call = (): unknown => original(...(args as never[]));
      if (depth > 0) return call();
      const taskId = route.taskOf(args);
      if (taskId && deps.role === "runner") refuseOnRunner(route, taskId, args);
      const hold = taskId ? repos.holds.get(taskId) : null;
      if (!taskId || !hold) return call();
      const task = repos.tasks.getAny(taskId);
      if (task) refuseOnBoard(route, task, hold.machineId, args);
      const result = core.write((fx) => {
        const lastEvent = repos.events.lastId();
        depth += 1;
        let made: { result: unknown; ids: string[] };
        try {
          made = core.recordIds(call);
        } finally {
          depth -= 1;
        }
        // A trailing argument left out would travel as null and read as given.
        const given = [...args];
        while (given.length > 0 && given.at(-1) === undefined) given.pop();
        const out = route.outbound ? route.outbound(given) : { args: given };
        // The call may have released the task itself (it can't today); then there is no one to send it to.
        if (out && repos.holds.get(taskId)) {
          const references: TaskReference[] = repos.tasks.getMany([...new Set(out.references ?? [])]).map(referenceOf);
          repos.holds.insertEdit({
            id: randomUUID(),
            taskId,
            machineId: hold.machineId,
            op: route.op,
            args: out.args,
            ids: made.ids,
            references,
            eventIds: repos.events.after(taskId, lastEvent).map((e) => e.id),
            settledHead: null,
            createdAt: core.now().toISOString(),
          });
          fx.task(taskId);
        }
        return { value: made.result, queued: out !== null };
      });
      if (result.queued) deps.onQueued(hold.machineId);
      return result.value;
    };

  for (const [name, methods] of Object.entries(routes)) {
    const service = services[name as keyof typeof routes] as unknown as Record<string, Method>;
    for (const [method, route] of Object.entries(methods)) {
      service[method] = wrap(route, service[method]!.bind(service));
    }
  }

  // What would take a held task out from under its machine is refused until the task is taken back.
  const { tasks, projects, holds } = services;
  const deleteTasks = tasks.delete.bind(tasks);
  tasks.delete = (ids, opts, actor) => {
    holds.assertNotHeld(
      ids.map((ref) => tasks.resolveId(ref)),
      "deleted",
    );
    return deleteTasks(ids, opts, actor);
  };
  const makeEpic = tasks.makeEpic.bind(tasks);
  tasks.makeEpic = (id, actor) => {
    holds.assertNotHeld([id], "made an epic");
    return makeEpic(id, actor);
  };
  const projectHolds = (id: string, what: string): void => {
    if (repos.holds.countInProject(id) === 0) return;
    throw new AppError(
      "CONFLICT",
      `${projects.get(id).title} has tasks a machine holds, so it can't be ${what}; take them back first`,
    );
  };
  const deleteProject = projects.delete.bind(projects);
  projects.delete = (id) => {
    projectHolds(id, "deleted");
    deleteProject(id);
  };
  const updateProject = projects.update.bind(projects);
  projects.update = (id, input) => {
    if (input.archived === true) projectHolds(id, "archived");
    return updateProject(id, input);
  };

  if (deps.role === "runner") {
    tasks.createEpic = () => {
      throw new AppError("CONFLICT", "An epic is made on the board, not on a machine it hands tasks to.");
    };
  }
}
