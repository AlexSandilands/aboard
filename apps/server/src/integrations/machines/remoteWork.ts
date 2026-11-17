import { createHash } from "node:crypto";
import {
  ApiErrorBody,
  MACHINE_JOBS_PATH,
  MACHINE_SESSIONS_PATH,
  MACHINE_SETTINGS_PATH,
  MACHINE_T3_PATH,
  MACHINE_TRANSCRIPT_PATH,
  MachineJobState,
  MachineSessionResult,
  machineAttachmentPath,
  machineJobPath,
  type AgentSessionRef,
  type MachineCapability,
  type MachineJobKind,
  type MachineJobRequest,
  type MachineSessionRequest,
  type MachineT3Request,
  type TaskSummary,
} from "@repo/contracts";
import { readRunnerOptions } from "../../autopilot/runnerOptions.ts";
import type { Runner, RunnerRequest, RunnerResult, RunPatch } from "../../autopilot/types.ts";
import { defaultBranchOf } from "../../autopilot/worktrees.ts";
import { AppError } from "../../errors.ts";
import type { Services } from "../../services/types.ts";
import type { RunGit } from "../backup.ts";
import { InterpreterMissingError, type ScriptRequest, type ScriptResult } from "../scriptRunner.ts";
import type { TranscriptRead } from "../sessionTranscript.ts";
import type { ShellRequest, ShellResult } from "../shellCommand.ts";
import { taskBranches } from "../taskBranches.ts";
import { messageOf, type Logger } from "../util.ts";
import type { MachinesIntegration } from "./index.ts";
import { reviveJobError } from "./jobs.ts";
import { machineSettingsOf } from "./runnerWork.ts";

// A board's side of work on a connected machine (docs/features/remote-machines.md#work-on-the-machine): a run, a
// command or a script for a task a machine holds is sent there as a job and read until it ends. Also what the
// machine needs from the board first: its settings, and the task's pasted images.

/** How long one read of a job is held open while it has nothing new. */
const JOB_WAIT_MS = 8_000;
const JOB_MARGIN_MS = 10_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/**
 * How long the board keeps asking a machine that stopped answering before it fails the run, counted from the
 * machine's last answer. The run's own timeout is the machine's to keep: it stops the agent there.
 */
const RUN_GRACE_MS = 15 * 60_000;
const COMMAND_GRACE_MS = 5 * 60_000;

/** A machine stayed silent past a job's grace period. */
class MachineUnreachableError extends Error {}

export interface RemoteWork {
  /** The machine holding a task, or null when the board holds it. */
  holder(taskId: string | null | undefined): { id: string; name: string } | null;
  /** Whether the machine said it can do `capability`; null until it has answered once. */
  can(machineId: string, capability: MachineCapability): boolean | null;
  /**
   * Has the machine holding the task act in its own T3 Code (`POST /machine/t3`) and answers what it said; null for a
   * task the board holds. Throws an AppError with the machine's own sentence when it refuses.
   */
  t3(taskId: string, request: MachineT3Request): Promise<unknown> | null;
  /** Has the machine holding the task make a CLI session's folder and link it; null for a task the board holds. */
  prepareSession(
    taskId: string,
    request: MachineSessionRequest,
  ): Promise<MachineSessionResult & { machine: { id: string; name: string } }> | null;
  /** `local`, except that agent work on a task a machine holds is done on that machine. */
  runner(local: Runner): Runner;
  /** Runs a custom automation's command on the machine holding its task; null for a task the board holds itself. */
  shell(request: ShellRequest): Promise<ShellResult> | null;
  script(request: ScriptRequest): Promise<ScriptResult> | null;
  /** Reads a page of the transcript of a session that ran on a connected machine; null when it ran here. */
  transcript(ref: AgentSessionRef, offset: number): Promise<TranscriptRead> | null;
  /**
   * Reads again the job a run sent to a machine before the board restarted (its id is the run's), applying what it
   * recorded from the start, until it ends: GET only, since a POST of an id the machine forgot would start a second
   * agent. The machine is asked again while it can't be reached, until RUN_GRACE_MS from this board's start. Never
   * throws: how the job ended is the answer.
   */
  reattach(machineId: string, runId: string, onUpdate: (patch: RunPatch) => void): Promise<JobEnding>;
  /** Tells a machine the board has a job's outcome, so it may forget it. Never throws. */
  forgetJob(machineId: string, jobId: string): void;
  /** Sends the board's settings to a machine when they differ from what it was last sent, or what it says it has. */
  syncSettings(machineId: string): Promise<void>;
  /**
   * What a machine says, with its log, it has of the board's settings: the revision it last took (null for none), or
   * undefined from a version that doesn't say. One that has another is sent them again.
   */
  observeSettings(machineId: string, revision: string | null | undefined): void;
  /**
   * Copies a task's pasted images to a machine, so the paths in its prompts resolve there. Never throws. `again`
   * sends them whatever was sent before: after a hand-over, since the machine drops a task's images with its copy.
   */
  sendImages(taskId: string, machineId: string, opts?: { again?: boolean }): Promise<void>;
  /**
   * What the machine can't see of a task's work: its branches in the board's checkout with commits that aren't on
   * origin, as a sentence; null when there are none (or no checkout to look in).
   */
  unpushed(
    taskId: string,
    machineName: string,
    also?: ReadonlyArray<string | null | undefined>,
  ): Promise<string | null>;
}

/** How a job the board re-attached to ended (`RemoteWork.reattach`). */
export type JobEnding =
  | { kind: "done"; result: RunnerResult }
  | { kind: "failed"; error: string }
  /** The machine has no such job and never ran it: it never got the request. */
  | { kind: "never_started" }
  /** The machine has no such job and can't say whether it ran it (a version from before it could). */
  | { kind: "unknown" }
  | { kind: "unreachable"; error: string };

export function createRemoteWork(deps: {
  services: () => Services;
  machines: Pick<MachinesIntegration, "request" | "can">;
  runGit: RunGit;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
}): RemoteWork {
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  /** When this board started: a re-attach's grace period counts from it, since its machine routes come up after. */
  const bootedAt = now();
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));
  const services = () => deps.services();
  /** Per machine, the settings last sent, so they go only when they change. */
  const sentSettings = new Map<string, string>();
  /**
   * Per machine that reports one, the revision of the board's settings it has: what it last said with its log, or
   * what it was sent since. Absent for a machine that doesn't say (an older version).
   */
  const heldSettings = new Map<string, string | null>();
  /**
   * Images a machine has, as `<machine>:<image>`, so the send before each run of one hold skips them. Only good for
   * as long as the machine holds the task: a hand-over sends them all again.
   */
  const sentImages = new Set<string>();

  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const refusal = async (res: Response, machineName: string, what: string): Promise<string> => {
    const body = ApiErrorBody.safeParse(await res.json().catch(() => null));
    if (body.success) return body.data.error.message;
    return res.status === 404
      ? `${machineName} runs a version that can't ${what}; update it first`
      : `${machineName} answered ${res.status}`;
  };

  /** The machine holding a task, or null when the board holds it. */
  const holderOf = (taskId: string | null | undefined): { id: string; name: string } | null => {
    const hold = taskId ? services().holds.get(taskId) : null;
    if (!hold) return null;
    return { id: hold.machineId, name: services().machines.get(hold.machineId).name };
  };

  /**
   * One request that answers at once, for interactive work a dialog waits on. A machine that can't be reached, or
   * runs a version without `capability`, is a CONFLICT saying so; a refusal carries the machine's own sentence.
   */
  const askNow = async (
    machine: { id: string; name: string },
    capability: MachineCapability,
    what: string,
    path: string,
    body: unknown,
  ): Promise<unknown> => {
    if (deps.machines.can(machine.id, capability) === false) {
      throw new AppError("CONFLICT", `${machine.name} runs a version that can't ${what}; update it first`);
    }
    let res: Response;
    try {
      // Long enough for T3 Code to make a worktree, or git to fetch before one.
      res = await deps.machines.request(machine.id, path, json("POST", body), { timeoutMs: 90_000 });
    } catch (error) {
      throw new AppError("CONFLICT", `${machine.name} holds this task and can't be reached: ${messageOf(error)}`);
    }
    if (!res.ok) {
      const refused = ApiErrorBody.safeParse(
        await res
          .clone()
          .json()
          .catch(() => null),
      );
      throw new AppError(
        refused.success ? refused.data.error.code : "CONFLICT",
        refused.success ? `On ${machine.name}: ${refused.data.error.message}` : await refusal(res, machine.name, what),
        refused.success ? refused.data.error.details : undefined,
      );
    }
    return res.json();
  };

  /**
   * How a job is asked about: one request, tried again while the machine can't be reached until it has been silent
   * for `graceMs` (counted from `since` until it first answers), which then throws `MachineUnreachableError`. An answer
   * that isn't a job's state throws.
   */
  const jobAsker = (machine: { id: string; name: string }, graceMs: number, since = now()) => {
    let lastAnswer = since;
    let delay = RETRY_MIN_MS;
    return async (path: string, init: RequestInit | undefined, timeoutMs: number): Promise<MachineJobState> => {
      for (;;) {
        let res: Response;
        try {
          res = await deps.machines.request(machine.id, path, init, { timeoutMs });
        } catch (error) {
          if (now() + delay - lastAnswer > graceMs) {
            throw new MachineUnreachableError(
              `${machine.name} couldn't be reached, so what became of this is unknown: ${messageOf(error)}`,
              { cause: error },
            );
          }
          await sleep(delay);
          delay = Math.min(delay * 2, RETRY_MAX_MS);
          continue;
        }
        delay = RETRY_MIN_MS;
        lastAnswer = now();
        if (!res.ok) throw new Error(await refusal(res, machine.name, "run things for a task"));
        return MachineJobState.parse(await res.json());
      }
    };
  };

  /** Reads a job from `state` on until it is no longer running, handing on each update once. Answers its last state. */
  const follow = async (
    jobId: string,
    first: MachineJobState,
    ask: ReturnType<typeof jobAsker>,
    onUpdate: (patch: Record<string, unknown>) => void,
  ): Promise<MachineJobState> => {
    let state = first;
    let after = 0;
    for (;;) {
      for (const { seq, patch } of state.updates) {
        if (seq <= after) continue;
        after = seq;
        onUpdate(patch);
      }
      if (state.state !== "running") return state;
      state = await ask(
        `${machineJobPath(jobId)}?after=${after}&wait=${JOB_WAIT_MS}`,
        undefined,
        JOB_WAIT_MS + JOB_MARGIN_MS,
      );
    }
  };

  const forgetJob: RemoteWork["forgetJob"] = (machineId, jobId) => {
    void deps.machines.request(machineId, machineJobPath(jobId), { method: "DELETE" }).catch(() => {});
  };

  /**
   * Starts a job on a machine and reads it to its end. A machine that can't be reached is asked again until it has
   * been silent for `graceMs`: the job goes on there meanwhile, however long it has been going, so a link that drops
   * late in a long run costs nothing. One that restarted has forgotten the job, which fails.
   */
  async function runJob(
    machine: { id: string; name: string },
    job: MachineJobRequest,
    graceMs: number,
    onUpdate: (patch: Record<string, unknown>) => void = () => {},
  ): Promise<unknown> {
    // Said before anything is sent: a runner from before work on a machine would only answer 404.
    if (deps.machines.can(machine.id, "runs") === false) {
      throw new Error(`${machine.name} runs a version that can't run things for a task; update it first`);
    }
    const ask = jobAsker(machine, graceMs);
    const state = await follow(job.id, await ask(MACHINE_JOBS_PATH, json("POST", job), JOB_MARGIN_MS), ask, onUpdate);
    if (state.state === "unknown") {
      throw new Error(`${machine.name} restarted while this was going, so it was cut short`);
    }
    // The board has the outcome: the machine needn't keep it.
    forgetJob(machine.id, job.id);
    if (state.state === "failed") {
      if (state.error?.name === "InterpreterMissingError") {
        throw new InterpreterMissingError(state.error.message.replace(/ not found on PATH$/, ""));
      }
      throw reviveJobError(state.error);
    }
    return state.result;
  }

  const reattach: RemoteWork["reattach"] = async (machineId, runId, onUpdate) => {
    const machine = { id: machineId, name: services().machines.get(machineId).name };
    // Not `can`: right after a start the board hasn't read what the machine can do yet.
    const ask = jobAsker(machine, RUN_GRACE_MS, bootedAt);
    let state: MachineJobState;
    try {
      state = await follow(
        runId,
        await ask(`${machineJobPath(runId)}?after=0`, undefined, JOB_MARGIN_MS),
        ask,
        onUpdate,
      );
    } catch (error) {
      return error instanceof MachineUnreachableError
        ? { kind: "unreachable", error: error.message }
        : { kind: "failed", error: messageOf(error) };
    }
    if (state.state === "done") return { kind: "done", result: (state.result ?? { result: null }) as RunnerResult };
    if (state.state === "failed") return { kind: "failed", error: reviveJobError(state.error).message };
    return state.state === "unknown" && state.started === false ? { kind: "never_started" } : { kind: "unknown" };
  };

  const jobId = (kind: MachineJobKind) => `${kind}-${crypto.randomUUID()}`;

  const syncSettings: RemoteWork["syncSettings"] = async (machineId) => {
    const settings = machineSettingsOf(services().settings.get());
    // Of what is sent, not of what the machine ends up with: it keeps its own CLI paths and skips what it can't read.
    const revision = createHash("sha256").update(JSON.stringify(settings)).digest("base64url").slice(0, 16);
    // With the version the machine was last seen on: one that was updated since (or reinstalled) is sent them again,
    // whatever it was sent before.
    const text = `${services().machines.get(machineId).version ?? ""}\n${JSON.stringify(settings)}`;
    // Also when a machine that says what it has has something else: its database was replaced at the same version.
    const lost = heldSettings.has(machineId) && heldSettings.get(machineId) !== revision;
    if (sentSettings.get(machineId) === text && !lost) return;
    const res = await deps.machines.request(machineId, MACHINE_SETTINGS_PATH, json("PUT", { settings, revision }));
    // A machine from before this (a 404) works by its own settings until it is updated, which changes its version.
    if (res.ok || res.status === 404) {
      sentSettings.set(machineId, text);
      if (heldSettings.has(machineId)) heldSettings.set(machineId, revision);
    }
  };

  const observeSettings: RemoteWork["observeSettings"] = (machineId, revision) => {
    if (revision === undefined) heldSettings.delete(machineId);
    else heldSettings.set(machineId, revision);
  };

  const unpushed: RemoteWork["unpushed"] = async (taskId, machineName, also = []) => {
    try {
      const task = services().tasks.summary(taskId);
      const root = services().projects.get(task.projectId).workspaceRoot;
      if (!root) return null;
      const defaultBranch = await defaultBranchOf(deps.runGit, root).catch(() => null);
      const found = await taskBranches({ task, root, defaultBranch, runGit: deps.runGit });
      const names = new Set([...found.map((b) => b.name), ...also.filter((n): n is string => Boolean(n))]);
      const behind: string[] = [];
      for (const name of names) {
        if (name === defaultBranch || name.startsWith("-")) continue;
        const exists = await deps.runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], root);
        if (exists.code !== 0) continue;
        // Commits on the branch that no branch of origin has, as this checkout last saw origin.
        const count = await deps.runGit(
          ["rev-list", "--count", `refs/heads/${name}`, "--not", "--remotes=origin"],
          root,
        );
        const n = count.code === 0 ? Number(count.stdout.trim()) : 0;
        if (n > 0) behind.push(`\`${name}\` (${n} commit${n === 1 ? "" : "s"})`);
      }
      if (behind.length === 0) return null;
      return (
        `${behind.join(", ")} ${behind.length === 1 ? "has" : "have"} commits that aren't pushed, so ${machineName} ` +
        `doesn't have them: it works from what is on origin. Push ${behind.length === 1 ? "the branch" : "them"} first.`
      );
    } catch (error) {
      log.warn(`[machines] couldn't look for unpushed commits: ${messageOf(error)}`);
      return null;
    }
  };

  /**
   * Sends one image to the machine as the task's. The machine stores it under the task, claimed or not here. False
   * for a machine from before images travelled (a 404).
   */
  const putImage = async (
    machineId: string,
    taskId: string,
    image: { id: string; filename: string; mime: string },
  ): Promise<boolean> => {
    const { bytes } = services().attachments.read(image.id);
    const query = new URLSearchParams({ taskId, filename: image.filename });
    const res = await deps.machines.request(machineId, `${machineAttachmentPath(image.id)}?${query.toString()}`, {
      method: "PUT",
      headers: { "content-type": image.mime },
      body: new Uint8Array(bytes),
    });
    if (res.ok) {
      sentImages.add(`${machineId}:${image.id}`);
      return true;
    }
    if (res.status !== 404) throw new Error(`the machine answered ${res.status}`);
    return false;
  };

  const sendImages: RemoteWork["sendImages"] = async (taskId, machineId, opts = {}) => {
    const s = services();
    for (const image of s.attachments.forTask(taskId)) {
      if (!opts.again && sentImages.has(`${machineId}:${image.id}`)) continue;
      // One at a time, each on its own: a file that is gone, or a link that dropped, doesn't keep the rest back.
      try {
        await putImage(machineId, taskId, image);
      } catch (error) {
        log.warn(`[machines] couldn't send the image ${image.filename} of a held task: ${messageOf(error)}`);
      }
    }
  };

  /**
   * The images pasted into a launch dialog, sent before the launch: they aren't the task's yet (the launch claims
   * them), so `sendImages` wouldn't send them, and the machine uploads them to its T3 Code from its own copies. Every
   * one must arrive, or the launch would fail there with a sentence about an image the user can see.
   */
  const sendLaunchImages = async (machine: { id: string; name: string }, taskId: string, ids: readonly string[]) => {
    if (ids.length === 0) return;
    // Checked here first, so an image that is gone is said as it is on a board.
    const images = services().attachments.forLaunch(ids, taskId);
    for (const image of images) {
      let sent: boolean;
      try {
        sent = await putImage(machine.id, taskId, image);
      } catch (error) {
        throw new AppError("CONFLICT", `Couldn't send ${image.filename} to ${machine.name}: ${messageOf(error)}`);
      }
      if (!sent) {
        throw new AppError(
          "CONFLICT",
          `${machine.name} runs a version that can't take images; update it first, or start without them`,
        );
      }
    }
  };

  /** Sends an agent run for a held task to its machine, recording there what the runner here would. */
  const startThere = async (
    machine: { id: string; name: string },
    task: TaskSummary,
    request: RunnerRequest,
    update: (patch: RunPatch) => void,
  ) => {
    const s = services();
    const options = readRunnerOptions(request.options, s.autopilot.engine().agentDefaults);
    const notes = [
      await unpushed(task.id, machine.name, [request.workspace?.branch, request.workspace?.baseRef]),
      // Whatever the automation's runner says: a thread would start on the board's own machine, not the task's.
      options.runner === "t3" ? `Ran headless on ${machine.name}: T3 Code threads don't run on a machine yet.` : null,
    ].filter(Boolean);
    const withNotes = (patch: RunPatch): RunPatch =>
      notes.length > 0 && patch.detail !== undefined
        ? { ...patch, detail: [...notes, patch.detail].filter(Boolean).join("\n") }
        : patch;
    if (notes.length > 0) update({ detail: notes.join("\n") });
    await syncSettings(machine.id).catch(() => {
      // The job's own request says what is wrong with the machine.
    });
    // Images pasted since the hand-over: the prompt may name them.
    await sendImages(task.id, machine.id);
    const { stillWanted: _stillWanted, ...sent } = request;
    const result = (await runJob(
      machine,
      {
        id: request.run.id,
        kind: "run",
        taskId: task.id,
        // The board's own defaults resolved here: the machine has none of the board's Autopilot settings.
        params: { request: { ...sent, options: { ...request.options, ...options, runner: "headless" } } },
      },
      RUN_GRACE_MS,
      (patch) => update(withNotes(patch)),
    )) as Awaited<ReturnType<Runner["start"]>>;
    return withNotes(result) as typeof result;
  };

  const command = <T>(kind: "shell" | "script", request: ShellRequest | ScriptRequest): Promise<T> | null => {
    const machine = holderOf(request.taskId);
    if (!machine || !request.taskId) return null;
    // The folder is the machine's own checkout, and the task goes as the job's.
    const { cwd: _cwd, taskId, ...rest } = request;
    return runJob(
      machine,
      { id: jobId(kind), kind, taskId, params: { request: rest } },
      COMMAND_GRACE_MS,
    ) as Promise<T>;
  };

  return {
    holder: holderOf,
    can: (machineId, capability) => deps.machines.can(machineId, capability),

    t3(taskId, request) {
      const machine = holderOf(taskId);
      if (!machine) return null;
      return (async () => {
        if (request.op === "start") await sendLaunchImages(machine, taskId, request.input.attachmentIds ?? []);
        return askNow(machine, "t3", "start T3 Code threads", MACHINE_T3_PATH, request);
      })();
    },

    prepareSession(taskId, request) {
      const machine = holderOf(taskId);
      if (!machine) return null;
      return (async () => {
        const answer = await askNow(machine, "sessions", "start sessions", MACHINE_SESSIONS_PATH, request);
        return { ...MachineSessionResult.parse(answer), machine };
      })();
    },

    runner: (local) => ({
      start(request, update = () => {}) {
        const machine = holderOf(request.run.taskId);
        // A nudge goes into a thread, which is on the board's machine whoever holds the task.
        if (!machine || request.kind === "nudge") return local.start(request, update);
        return startThere(machine, services().tasks.summary(request.run.taskId!), request, update);
      },
    }),

    shell: (request) => command<ShellResult>("shell", request),
    script: (request) => command<ScriptResult>("script", request),

    transcript(ref, offset) {
      if (!ref.machine) return null;
      const machine = services().machines.byInstance(ref.machine.id);
      const name = machine?.name ?? ref.machine.name;
      if (!machine) {
        return Promise.reject(
          new AppError(
            "NOT_FOUND",
            `Session ${ref.sessionId} ran on ${name}, which this board is no longer connected to, so its transcript can't be read.`,
          ),
        );
      }
      return (async () => {
        let res: Response;
        try {
          res = await deps.machines.request(
            machine.id,
            MACHINE_TRANSCRIPT_PATH,
            json("POST", { sessionId: ref.sessionId, cwd: ref.cwd, offset }),
          );
        } catch (error) {
          throw new AppError(
            "CONFLICT",
            `Session ${ref.sessionId} ran on ${name}, which can't be reached right now: ${messageOf(error)}`,
          );
        }
        if (!res.ok) {
          throw new AppError(
            res.status === 404 ? "NOT_FOUND" : "CONFLICT",
            await refusal(res, name, "serve transcripts"),
          );
        }
        return (await res.json()) as TranscriptRead;
      })();
    },

    reattach,

    forgetJob,

    syncSettings,

    observeSettings,

    sendImages,

    unpushed,
  };
}
