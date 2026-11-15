import {
  ApiErrorBody,
  CallToolParams,
  ChangesResponse,
  HeldEditResult,
  MACHINE_CHANGES_PATH,
  MACHINE_EDITS_PATH,
  MACHINE_REPLIES_PATH,
  LogPosition,
  MACHINE_TASKS_PATH,
  machineTaskPath,
  taskLabel,
  type BridgeReply,
  type BridgeRequest,
  type CallToolReply,
  type HeldEditRequest,
  type TaskDetail,
} from "@repo/contracts";
import type { EventBus } from "../../bus.ts";
import { AppError } from "../../errors.ts";
import type { ApplyResult } from "../../services/holds.ts";
import type { Services } from "../../services/types.ts";
import type { RunGit } from "../backup.ts";
import { messageOf, type Logger } from "../util.ts";
import { remoteIdentity } from "./checkouts.ts";
import type { MachinesIntegration } from "./index.ts";

// A board's side of held tasks, live (docs/features/remote-machines.md#held-tasks): handing a task to a machine and
// taking it back, reading the machine's change log and applying it, sending the edits made here, and answering
// what the machine asks. What is stored is services/holds.

/** How long one read of a machine's log is held open while it has nothing to say. */
const POLL_WAIT_MS = 8_000;
/** On top of the wait: the request itself. */
const POLL_MARGIN_MS = 10_000;
/** A hand-over may clone the project's repository on the machine first. */
const HAND_OVER_TIMEOUT_MS = 35 * 60_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** How long the board's projects' repositories are remembered before `origin` is read again. */
const REMOTES_TTL_MS = 10 * 60_000;
/** Reads of the log after a release before giving up on seeing it. */
const RELEASE_READS = 5;

/** Runs one of this board's MCP tools for a machine that asked (a task it doesn't hold). */
export type CallTool = (params: CallToolParams) => Promise<CallToolReply>;

export interface MachineSyncDeps {
  services: () => Services;
  machines: Pick<MachinesIntegration, "request">;
  bus: EventBus;
  runGit: RunGit;
  now?: () => Date;
  log?: Logger;
}

export interface MachineSync {
  /** Hands a task to a connected machine, which then orders every change to it. */
  handOver(taskId: string, machineId: string, actor: string): Promise<TaskDetail>;
  /**
   * Takes a task back. The machine gives it up and its last changes are applied first; with `force` the board
   * doesn't wait for a machine it can't reach, and what that machine changed since is lost.
   */
  release(taskId: string, opts: { force?: boolean }, actor: string): Promise<TaskDetail>;
  /**
   * One round with a machine: sends the edits waiting for it, reads its log (holding the read open up to `wait`
   * ms), applies it and answers what it asked. Throws when the machine can't be reached.
   */
  pump(machineId: string, opts?: { wait?: number }): Promise<ApplyResult>;
  /** Sends a machine's waiting edits now, without waiting for the next round. Never throws. */
  flush(machineId: string): void;
  /** How a machine's tool calls are run; set once the app that serves them exists. */
  setToolCaller(call: CallTool): void;
  start(): void;
  stop(): void;
}

export function createMachineSync(deps: MachineSyncDeps): MachineSync {
  const log = deps.log ?? console;
  const now = deps.now ?? (() => new Date());
  const services = () => deps.services();
  let callTool: CallTool | null = null;
  let started = false;
  /** Tasks being handed over: the machine has them before the board has recorded it. */
  const handing = new Set<string>();
  /** One sender per machine, so edits arrive in the order they were made. */
  const sending = new Map<string, Promise<void>>();
  const loops = new Set<string>();
  let remotes: { at: number; byRemote: Map<string, string> } | null = null;
  /** Per machine, the log position replay is stuck at, once it has been reported. */
  const unreadable = new Map<string, number>();

  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const refusal = async (res: Response, machineName: string): Promise<string> => {
    const body = ApiErrorBody.safeParse(await res.json().catch(() => null));
    if (body.success) return body.data.error.message;
    return res.status === 404
      ? `${machineName} runs a version that can't hold tasks; update it first`
      : `${machineName} answered ${res.status}`;
  };

  /** The repository a folder's `origin` names, or null without one. */
  const remoteOf = async (workspaceRoot: string | null): Promise<{ remote: string; remoteUrl: string } | null> => {
    if (!workspaceRoot) return null;
    const result = await deps.runGit(["remote", "get-url", "origin"], workspaceRoot).catch(() => null);
    const remoteUrl = result?.code === 0 ? result.stdout.trim() : "";
    const remote = remoteUrl ? remoteIdentity(remoteUrl) : null;
    return remote ? { remote, remoteUrl } : null;
  };

  /** This board's project for each repository, for tasks made on a machine in a project the board didn't name. */
  const projectsByRemote = async (): Promise<Map<string, string>> => {
    if (remotes && now().getTime() - remotes.at < REMOTES_TTL_MS) return remotes.byRemote;
    const byRemote = new Map<string, string>();
    for (const project of services().projects.list()) {
      const found = await remoteOf(project.workspaceRoot);
      if (found && !byRemote.has(found.remote)) byRemote.set(found.remote, project.id);
    }
    remotes = { at: now().getTime(), byRemote };
    return byRemote;
  };

  async function sendEdits(machineId: string): Promise<void> {
    for (const edit of services().holds.pendingEdits(machineId)) {
      const request: HeldEditRequest = {
        id: edit.id,
        taskId: edit.taskId,
        op: edit.op,
        args: edit.args,
        ids: edit.ids,
        references: edit.references,
      };
      const res = await deps.machines.request(machineId, MACHINE_EDITS_PATH, json(request));
      const parsed = res.ok ? HeldEditResult.safeParse(await res.json().catch(() => null)) : null;
      if (parsed?.success) services().holds.settleEdit(edit.id, parsed.data);
      // The runner failed, and may not next time: the edit stays queued, in front of the later ones.
      else if (res.status >= 500 || res.ok) throw new Error(`The machine couldn't take an edit (${res.status})`);
      else {
        // A runner that can read the request gives its verdict even on an edit it can't make sense of, with the
        // state logged. This one answered without one (a version from before edits): refused, not retried forever.
        const error = await refusal(res, "The machine");
        services().holds.settleEdit(edit.id, { applied: false, error, head: 0 });
      }
    }
  }

  /** Runs `sendEdits` after whatever is already being sent to the machine. */
  const sendInOrder = (machineId: string): Promise<void> => {
    const next = (sending.get(machineId) ?? Promise.resolve()).catch(() => {}).then(() => sendEdits(machineId));
    sending.set(machineId, next);
    void next
      .finally(() => {
        if (sending.get(machineId) === next) sending.delete(machineId);
      })
      .catch(() => {});
    return next;
  };

  async function answer(machineId: string, request: BridgeRequest): Promise<void> {
    let reply: BridgeReply;
    try {
      if (request.method === "allocateNumber") {
        reply = { id: request.id, ok: true, result: { number: services().holds.allocateNumber() } };
      } else if (request.method === "callTool") {
        if (!callTool) throw new Error("This board can't run tools for a machine yet");
        reply = { id: request.id, ok: true, result: await callTool(CallToolParams.parse(request.params)) };
      } else {
        // A newer runner asking for something this board doesn't know: it falls back as if the board were away.
        reply = { id: request.id, ok: false, error: `This board doesn't know "${request.method}"` };
      }
    } catch (error) {
      reply = { id: request.id, ok: false, error: messageOf(error) };
    }
    await deps.machines.request(machineId, MACHINE_REPLIES_PATH, json(reply));
  }

  async function pump(machineId: string, opts: { wait?: number } = {}): Promise<ApplyResult> {
    await sendInOrder(machineId);
    const position = services().holds.position(machineId);
    const wait = opts.wait ?? 0;
    const query = new URLSearchParams({
      after: String(position.appliedLogId),
      wait: String(wait),
      prefix: position.prefix,
      counter: String(position.counter),
      ...(position.epoch ? { epoch: position.epoch } : {}),
    });
    const res = await deps.machines.request(machineId, `${MACHINE_CHANGES_PATH}?${query.toString()}`, undefined, {
      timeoutMs: wait + POLL_MARGIN_MS,
    });
    if (!res.ok) throw new AppError("CONFLICT", await refusal(res, services().machines.get(machineId).name));
    const changes = ChangesResponse.parse(await res.json());
    const madeThere = changes.entries.some((entry) => entry.kind === "created");
    const result = services().holds.apply(machineId, changes, madeThere ? await projectsByRemote() : undefined);
    // Said once per entry: the loop comes back to it until the board can read it.
    if (result.error && unreadable.get(machineId) !== result.appliedLogId) {
      unreadable.set(machineId, result.appliedLogId);
      log.warn(`[machines] ${services().machines.get(machineId).name}'s log: ${result.error}`);
    }
    if (!result.error) unreadable.delete(machineId);
    for (const taskId of result.stray) {
      if (handing.has(taskId)) continue;
      // Held there, not handed over from here (taken back by force while it was away): it drops its copy.
      await deps.machines.request(machineId, machineTaskPath(taskId), { method: "DELETE" }).catch(() => {});
    }
    for (const request of changes.requests) {
      await answer(machineId, request).catch((error: unknown) => {
        log.warn(`[machines] couldn't answer a machine's request: ${messageOf(error)}`);
      });
    }
    return result;
  }

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    });

  /** Reads one machine's log for as long as the board runs and still knows the machine. */
  async function loop(machineId: string): Promise<void> {
    let delay = RETRY_MIN_MS;
    try {
      const running = () => started;
      while (running()) {
        if (
          !services()
            .machines.list()
            .some((m) => m.id === machineId)
        )
          return;
        try {
          const result = await pump(machineId, { wait: POLL_WAIT_MS });
          // An entry this board can't read stays where it is, and the runner answers at once while it does: wait
          // as for a machine that can't be reached, rather than ask again straight away.
          if (result.error) throw new Error(result.error);
          delay = RETRY_MIN_MS;
        } catch {
          // Not connected, or it dropped: the link keeps trying its routes, and this waits for it.
          await sleep(delay);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
        }
      }
    } finally {
      loops.delete(machineId);
    }
  }

  const startLoops = (): void => {
    if (!started) return;
    for (const machine of services().machines.list()) {
      if (loops.has(machine.id)) continue;
      loops.add(machine.id);
      void loop(machine.id);
    }
  };

  // A machine connected after the board started gets its loop then.
  deps.bus.subscribe((event) => {
    if (event.type === "machines.changed") startLoops();
  });

  return {
    async handOver(taskId, machineId, actor) {
      const task = services().tasks.summary(taskId);
      const project = services().projects.get(task.projectId);
      const machine = services().machines.get(machineId);
      const request = services().holds.prepare(taskId, machineId, await remoteOf(project.workspaceRoot));
      handing.add(taskId);
      try {
        const res = await deps.machines.request(machineId, MACHINE_TASKS_PATH, json(request), {
          timeoutMs: HAND_OVER_TIMEOUT_MS,
        });
        if (!res.ok) throw new AppError("CONFLICT", await refusal(res, machine.name));
        try {
          const { head } = LogPosition.parse(await res.json());
          return services().holds.confirm(taskId, machineId, request.state, head, actor);
        } catch (error) {
          // The machine has a copy the board won't follow: it gives it up again.
          await deps.machines.request(machineId, machineTaskPath(taskId), { method: "DELETE" }).catch(() => {});
          throw error;
        }
      } finally {
        handing.delete(taskId);
      }
    },

    async release(taskId, opts, actor) {
      const hold = services().holds.get(taskId);
      const task = services().tasks.summary(taskId);
      if (!hold) throw new AppError("VALIDATION", `${taskLabel(task)} isn't held by a machine`);
      const machine = services().machines.get(hold.machineId);
      if (opts.force) {
        services().holds.forceRelease(taskId, actor);
        await deps.machines.request(machine.id, machineTaskPath(taskId), { method: "DELETE" }).catch(() => {});
        return services().tasks.detail(taskId);
      }
      try {
        // Edits made here go first, so they are in what the machine gives back.
        await sendInOrder(machine.id);
        const res = await deps.machines.request(machine.id, machineTaskPath(taskId), { method: "DELETE" });
        if (!res.ok) throw new AppError("CONFLICT", await refusal(res, machine.name));
        // The release is the log's last entry: every read that leaves more to read doesn't count.
        for (let read = 0; read < RELEASE_READS && services().holds.get(taskId); read++) {
          let result = await pump(machine.id);
          while (result.more && !result.error) result = await pump(machine.id);
        }
      } catch (error) {
        throw new AppError(
          "CONFLICT",
          `${taskLabel(task)} couldn't be taken back from ${machine.name}: ${messageOf(error)} ` +
            "Taking it back by force doesn't wait for the machine, and loses what it changed since it was last reached.",
        );
      }
      if (services().holds.get(taskId)) {
        throw new AppError("CONFLICT", `${machine.name} hasn't given ${taskLabel(task)} back yet; try again`);
      }
      return services().tasks.detail(taskId);
    },

    pump,

    flush(machineId) {
      sendInOrder(machineId).catch(() => {
        // Not reachable now: the edits wait, and go with the next round.
      });
    },

    setToolCaller(call) {
      callTool = call;
    },

    start() {
      if (started) return;
      started = true;
      startLoops();
    },

    stop() {
      started = false;
    },
  };
}
