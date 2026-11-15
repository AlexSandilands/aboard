import {
  RUN_HERE,
  resolveRunOn,
  runOnLocked,
  taskNumberText,
  type Machine,
  type Project,
  type TaskSummary,
} from "@repo/contracts";

// Where a task runs, as the card, the task panel and the hand-off window show it
// (docs/features/remote-machines.md#choosing-the-machine).

type RunOnTask = Pick<TaskSummary, "kind" | "manual" | "archivedAt" | "status" | "runOn" | "hold">;
type RunOnProject = Pick<Project, "workspaceRoot" | "runOn">;
type MachineLike = Pick<Machine, "id" | "name" | "prefix" | "connection" | "lastSeenAt">;

/** A machine that can't be worked with now; `connecting` is only the link coming up, so it isn't counted. */
export function machineOffline(machine: Pick<Machine, "connection">): boolean {
  return machine.connection !== "connected" && machine.connection !== "connecting";
}

/** What the card's number and the panel's chip say about where the task is. */
export type Placement =
  /** It runs here: nothing to show. */
  | { state: "here" }
  /** It hasn't started, and will start on this machine. */
  | { state: "will"; machine: MachineLike }
  /** A machine holds it. `machine` is undefined when the board no longer lists it. */
  | {
      state: "held";
      machineId: string;
      machineName: string;
      machine: MachineLike | undefined;
      waiting: number;
      offline: boolean;
    };

export function placementOf(
  task: RunOnTask,
  project: RunOnProject | undefined,
  machines: readonly MachineLike[],
): Placement {
  if (task.hold) {
    const machine = machines.find((m) => m.id === task.hold!.machineId);
    return {
      state: "held",
      machineId: task.hold.machineId,
      machineName: machine?.name ?? task.hold.machineName,
      machine,
      waiting: task.hold.waiting,
      offline: machine ? machineOffline(machine) : false,
    };
  }
  // A task that started here stays here, whatever it was set to.
  if (runOnLocked(task) || task.kind === "epic" || task.manual || task.archivedAt) return { state: "here" };
  const { machineId } = resolveRunOn(task.runOn, project?.runOn, (id) => machines.some((m) => m.id === id));
  const machine = machineId ? machines.find((m) => m.id === machineId) : undefined;
  return machine ? { state: "will", machine } : { state: "here" };
}

/** A machine a task can be set to run on: paired, and on a version that can take it (it may be away for now). */
export function machineUsable(machine: Pick<Machine, "connection">): boolean {
  return machine.connection !== "unpaired" && machine.connection !== "needs-update";
}

/**
 * Whether the task's machine can be chosen: a code task that hasn't started, in a project with a folder (a repository a
 * machine can clone), on a board with a usable machine.
 */
export function canChooseRunOn(
  task: RunOnTask,
  project: RunOnProject | undefined,
  machines: ReadonlyArray<Pick<Machine, "connection">>,
): boolean {
  if (!machines.some(machineUsable) || !project?.workspaceRoot) return false;
  if (task.kind === "epic" || task.manual || task.archivedAt) return false;
  return !runOnLocked(task);
}

export interface RunOnOption {
  /** What `PUT run-on` takes: null follows the project, `here`, or a machine's id. */
  value: string | null;
  label: string;
  detail: string;
  /** A machine that can't be worked with now; still shown, so the user sees why. */
  disabled: boolean;
  machine?: MachineLike;
}

const CONNECTION_DETAIL: Record<Machine["connection"], string> = {
  connected: "Connected",
  connecting: "Connecting",
  unreachable: "Can't be reached",
  "needs-update": "Needs updating first",
  unpaired: "Needs pairing again",
};

/** The menu: the project's default, this machine, then each connected machine with how it is. */
export function runOnOptions(project: RunOnProject | undefined, machines: readonly MachineLike[]): RunOnOption[] {
  const fallback = machines.find((m) => m.id === project?.runOn);
  return [
    {
      value: null,
      label: "Project default",
      detail: fallback ? fallback.name : "This machine",
      disabled: false,
    },
    {
      value: RUN_HERE,
      label: "This machine",
      detail: "Where the board runs",
      disabled: false,
    },
    ...machines.map((machine) => ({
      value: machine.id,
      label: machine.name,
      detail: CONNECTION_DETAIL[machine.connection],
      disabled: machineOffline(machine),
      machine,
    })),
  ];
}

/**
 * The card's number with the machine's letter in front: `E` and `182` for #182. A task a machine numbered while the
 * board was away already reads `#E7`, so it keeps that whole, and gets the letter only when another machine has it:
 * the pill never reads like a different task's number.
 */
export function machineNumberParts(
  task: Pick<TaskSummary, "number" | "numberPrefix">,
  placement: Exclude<Placement, { state: "here" }>,
): { letter: string; rest: string } {
  const letter =
    placement.state === "will"
      ? placement.machine.prefix
      : (placement.machine?.prefix ?? placement.machineName.slice(0, 1).toUpperCase());
  if (!task.numberPrefix) return { letter, rest: String(task.number) };
  const own = `#${taskNumberText(task)}`;
  return task.numberPrefix === letter ? { letter: "", rest: own } : { letter, rest: own };
}

/** The chip before the task starts: "Run on engine", or "Run on this machine". */
export function runOnLabel(placement: Placement): string {
  return placement.state === "will" ? `Run on ${placement.machine.name}` : "Run on this machine";
}

/** The chip once a machine holds the task. */
export function heldLabel(placement: Extract<Placement, { state: "held" }>): string {
  if (placement.offline) return `${placement.machineName} · offline`;
  return placement.waiting > 0
    ? `On ${placement.machineName} · ${placement.waiting} waiting`
    : `On ${placement.machineName}`;
}

/** The sentence a hover or the card's number shows. */
export function placementTitle(placement: Placement, now = Date.now()): string | null {
  switch (placement.state) {
    case "here":
      return null;
    case "will":
      return `Starts on ${placement.machine.name}: Autopilot hands it over when it starts the task.`;
    case "held": {
      const name = placement.machineName;
      const head = placement.offline
        ? `${name} holds this task but ${sinceText(placement.machine?.lastSeenAt ?? null, now)}. Its agent carries on there; what you change here waits for it.`
        : `${name} holds this task and orders its changes; what you change here goes through it.`;
      if (placement.waiting === 0) return head;
      const edits = placement.waiting === 1 ? "1 change made here is" : `${placement.waiting} changes made here are`;
      return `${head} ${edits} waiting for it: shown already, applied once it can be reached.`;
    }
  }
}

/** "hasn't answered since 14:02", or "can't be reached" when it never has. */
export function sinceText(lastSeenAt: string | null, now = Date.now()): string {
  if (!lastSeenAt) return "can't be reached";
  const at = new Date(lastSeenAt);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const when = sameDay
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleDateString([], { month: "short", day: "numeric" });
  return `hasn't answered since ${when}`;
}

/**
 * What the hand-off windows say about a task that runs on another machine: `blocker` when a thread or session from
 * here would do its work on this machine (the window's Send is off), else a `note` to show. Planning doesn't start the
 * task (it stays in Backlog or Planned), so a planning launch goes ahead for a task that will start on a machine. A
 * task a machine already holds gets its threads and sessions there, so they go ahead too.
 */
export function launchElsewhere(
  placement: Placement,
  planning: boolean,
): { blocker: string | null; note: string | null } {
  if (placement.state === "held") {
    // Its threads and sessions start on the machine (remote-machines.md#interactive-work), so they go ahead.
    return { blocker: null, note: `${placement.machineName} holds this task: the thread or session starts there.` };
  }
  if (placement.state !== "will") return { blocker: null, note: null };
  const name = placement.machine.name;
  if (planning) {
    return {
      blocker: null,
      note: `Planning here is fine: the task stays where it is. It starts on ${name} when Autopilot's Start planned starts it.`,
    };
  }
  const text = `This task runs on ${name}. Autopilot's Start planned starts it there once its Autopilot flag is on; a thread or session from here would run on this machine. Choose This machine to start it here, or plan it with Plan with me.`;
  return { blocker: text, note: text };
}
