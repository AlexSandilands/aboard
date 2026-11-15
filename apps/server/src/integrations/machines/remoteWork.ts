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
import type { Runner, RunnerRequest, RunPatch } from "../../autopilot/types.ts";
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

export interface RemoteWork {
  /** The machine holding a task, or null when the board holds it. */
  holder(taskId: string | null | undefined): { id: string; name: string } | null;
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
  /** Sends the board's settings to a machine when they differ from what it was last sent. */
  syncSettings(machineId: string): Promise<void>;
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
    let lastAnswer = now();
    let delay = RETRY_MIN_MS;
    /** One request, tried again while the machine can't be reached. An answer that isn't a job's state throws. */
    const ask = async (path: string, init: RequestInit | undefined, timeoutMs: number): Promise<MachineJobState> => {
      for (;;) {
        let res: Response;
        try {
          res = await deps.machines.request(machine.id, path, init, { timeoutMs });
        } catch (error) {
          if (now() + delay - lastAnswer > graceMs) {
            throw new Error(
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
    let state = await ask(MACHINE_JOBS_PATH, json("POST", job), JOB_MARGIN_MS);
    let after = 0;
    for (;;) {
      for (const { seq, patch } of state.updates) {
        if (seq <= after) continue;
        after = seq;
        onUpdate(patch);
      }
      if (state.state === "running") {
        state = await ask(
          `${machineJobPath(job.id)}?after=${after}&wait=${JOB_WAIT_MS}`,
          undefined,
          JOB_WAIT_MS + JOB_MARGIN_MS,
        );
        continue;
      }
      if (state.state === "unknown") {
        throw new Error(`${machine.name} restarted while this was going, so it was cut short`);
      }
      // The board has the outcome: the machine needn't keep it.
      void deps.machines.request(machine.id, machineJobPath(job.id), { method: "DELETE" }).catch(() => {});
      if (state.state === "failed") {
        if (state.error?.name === "InterpreterMissingError") {
          throw new InterpreterMissingError(state.error.message.replace(/ not found on PATH$/, ""));
        }
        throw reviveJobError(state.error);
      }
      return state.result;
    }
  }

  const jobId = (kind: MachineJobKind) => `${kind}-${crypto.randomUUID()}`;

  const syncSettings: RemoteWork["syncSettings"] = async (machineId) => {
    const settings = machineSettingsOf(services().settings.get());
    // With the version the machine was last seen on: one that was updated since (or reinstalled) is sent them again,
    // whatever it was sent before.
    const text = `${services().machines.get(machineId).version ?? ""}\n${JSON.stringify(settings)}`;
    if (sentSettings.get(machineId) === text) return;
    const res = await deps.machines.request(machineId, MACHINE_SETTINGS_PATH, json("PUT", { settings }));
    // A machine from before this (a 404) works by its own settings until it is updated, which changes its version.
    if (res.ok || res.status === 404) sentSettings.set(machineId, text);
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

  const sendImages: RemoteWork["sendImages"] = async (taskId, machineId, opts = {}) => {
    const s = services();
    for (const image of s.attachments.forTask(taskId)) {
      if (!opts.again && sentImages.has(`${machineId}:${image.id}`)) continue;
      // One at a time, each on its own: a file that is gone, or a link that dropped, doesn't keep the rest back.
      try {
        const { bytes } = s.attachments.read(image.id);
        const query = new URLSearchParams({ taskId, filename: image.filename });
        const res = await deps.machines.request(machineId, `${machineAttachmentPath(image.id)}?${query.toString()}`, {
          method: "PUT",
          headers: { "content-type": image.mime },
          body: new Uint8Array(bytes),
        });
        // A machine from before images travelled (a 404) is left without them.
        if (res.ok) sentImages.add(`${machineId}:${image.id}`);
        else if (res.status !== 404) throw new Error(`the machine answered ${res.status}`);
      } catch (error) {
        log.warn(`[machines] couldn't send the image ${image.filename} of a held task: ${messageOf(error)}`);
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

    t3(taskId, request) {
      const machine = holderOf(taskId);
      if (!machine) return null;
      return (async () => {
        // The dialog's images: the machine uploads them to its T3 from its own copies.
        if (request.op === "start") await sendImages(taskId, machine.id);
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

    syncSettings,

    sendImages,

    unpushed,
  };
}
