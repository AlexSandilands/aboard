import {
  AutopilotRun,
  UpdateSettingsInput,
  taskLabel,
  type AppSettings,
  type MachineJobRequest,
  type MachineJobState,
} from "@repo/contracts";
import { z } from "zod";
import type { Runner, RunnerRequest, RunPatch } from "../../autopilot/types.ts";
import { AppError } from "../../errors.ts";
import type { Services } from "../../services/types.ts";
import type { RunScript, ScriptRequest } from "../scriptRunner.ts";
import type { RunShell, ShellRequest } from "../shellCommand.ts";
import { messageOf, type Logger } from "../util.ts";
import type { JobHandler, MachineJobs } from "./jobs.ts";

// What a runner does for its board on a task it holds (docs/features/remote-machines.md#work-on-the-machine): a
// headless run with the same runner code a board uses, and a custom automation's command or script, in this
// machine's own checkout and as its own user.

/**
 * The board's settings a machine works by, since its own were never set by anyone: whether a move to Review opens a
 * round, how many rounds, the board's reviewer and its budget, and which model each operation runs on. Everything
 * about the machine itself (where its CLIs are, its name, its terminal) stays its own.
 */
export const MACHINE_SETTING_KEYS = [
  "autoReview",
  "reviewMaxRounds",
  "headlessReviewEnabled",
  "headlessReviewBudgetUsd",
  "reviewSkill",
  "operationModels",
  "modelTiers",
  "modelProfiles",
  "providers",
  "ticketSystems",
] as const satisfies ReadonlyArray<keyof AppSettings & keyof UpdateSettingsInput>;

/** What a board sends a machine of its settings. A review skill kept in a file here isn't on the machine: it keeps its own. */
export function machineSettingsOf(settings: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MACHINE_SETTING_KEYS) {
    if (key === "reviewSkill" && settings.reviewSkill.source !== "builtin") continue;
    out[key] = settings[key];
  }
  return out;
}

const RunParams = z.object({
  request: z.looseObject({
    run: AutopilotRun,
    prompt: z.string(),
    operation: z.string(),
    options: z.record(z.string(), z.unknown()),
  }),
});
const ShellParams = z.object({
  request: z.object({ command: z.string(), env: z.record(z.string(), z.string()), timeoutMs: z.number().positive() }),
});
const ScriptParams = z.object({
  request: z.object({
    language: z.string(),
    body: z.string(),
    env: z.record(z.string(), z.string()),
    context: z.unknown(),
    timeoutMs: z.number().positive(),
  }),
});

export interface RunnerWork {
  /** Starts a job the board sent. Throws VALIDATION for one this version can't do, CONFLICT for a task not held here. */
  start(request: MachineJobRequest): MachineJobState;
  /** Takes the board's settings as this machine's own, keeping where its own CLIs are. */
  applySettings(settings: Record<string, unknown>): void;
}

export function createRunnerWork(deps: {
  services: () => Services;
  jobs: MachineJobs;
  runner: Runner;
  /** A run ended, with the session it had: its link's state is read again at once. */
  runEnded?: (sessionId: string) => void;
  runShell: RunShell;
  runScript: RunScript;
  log?: Logger;
}): RunnerWork {
  const log = deps.log ?? console;

  /** The folder a held task's commands run in: this machine's checkout of its project. */
  const checkoutOf = (taskId: string): string => {
    const s = deps.services();
    const task = s.tasks.summary(taskId);
    const project = s.projects.get(task.projectId);
    if (!project.workspaceRoot) {
      throw new Error(`${project.title} has no repository on this machine to run that in`);
    }
    return project.workspaceRoot;
  };

  const run: JobHandler = async (job, update) => {
    const s = deps.services();
    const sent = RunParams.parse(job.params).request as unknown as RunnerRequest;
    const task = s.tasks.summary(job.taskId);
    // The board's run, kept here so this machine counts it, finds its session and cleans up its worktree.
    const adopted = s.autopilot.adopt({ ...sent.run, taskId: task.id }, task.projectId);
    const record = (patch: RunPatch) => {
      try {
        s.autopilot.update(adopted.id, patch);
      } catch (error) {
        log.warn(`[machines] couldn't record run ${adopted.id}: ${messageOf(error)}`);
      }
      if (patch.sessionId) sessionId = patch.sessionId;
      update(patch);
    };
    let sessionId: string | null = null;
    const ended = () => {
      if (sessionId) deps.runEnded?.(sessionId);
    };
    try {
      const result = await deps.runner.start(
        {
          ...sent,
          run: adopted,
          // A T3 thread is the board's; here every run is headless, from what origin has.
          kind: "start",
          options: { ...sent.options, runner: "headless" },
          workspace: { ...sent.workspace, fromOrigin: true },
        },
        record,
      );
      const { result: _text, output: _output, ...patch } = result;
      s.autopilot.settle(adopted.id, "succeeded", patch);
      sessionId = result.sessionId ?? sessionId;
      ended();
      return result;
    } catch (error) {
      s.autopilot.settle(adopted.id, "failed", { error: messageOf(error) });
      ended();
      throw error;
    }
  };

  const shell: JobHandler = (job) => {
    const { request } = ShellParams.parse(job.params);
    return deps.runShell({ ...request, cwd: checkoutOf(job.taskId), taskId: job.taskId } satisfies ShellRequest);
  };

  const script: JobHandler = (job) => {
    const { request } = ScriptParams.parse(job.params);
    return deps.runScript({
      ...request,
      cwd: checkoutOf(job.taskId),
      taskId: job.taskId,
    } as ScriptRequest);
  };

  const handlers: Record<string, JobHandler> = { run, shell, script };

  return {
    start(request) {
      const handler = handlers[request.kind];
      if (!handler) {
        throw new AppError("VALIDATION", `This machine's version can't do "${request.kind}"; update it`);
      }
      const s = deps.services();
      if (s.workingCopies.role(request.taskId) !== "held") {
        let label = "That task";
        try {
          label = taskLabel(s.tasks.summary(request.taskId));
        } catch {
          // Not a task this machine has at all.
        }
        throw new AppError("CONFLICT", `${label} isn't held by this machine, so nothing runs for it here`);
      }
      return deps.jobs.start(request, handler);
    },

    applySettings(settings) {
      const s = deps.services();
      const own = s.settings.get();
      // Each key on its own: one a newer board shapes differently is left as it was, and the rest still apply.
      const patch: Record<string, unknown> = {};
      for (const key of MACHINE_SETTING_KEYS) {
        if (settings[key] === undefined) continue;
        const parsed = UpdateSettingsInput.shape[key].safeParse(settings[key]);
        if (parsed.success && parsed.data !== undefined) patch[key] = parsed.data;
      }
      const input = patch as UpdateSettingsInput;
      if (input.providers) {
        // Which providers are on is the board's; where each CLI is on this machine is its own.
        input.providers = input.providers.map((p) => ({
          ...p,
          cliPath: own.providers.find((o) => o.id === p.id)?.cliPath ?? null,
        }));
      }
      const changed = Object.entries(input).some(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(own[key as keyof AppSettings]),
      );
      if (changed) s.settings.update(input);
    },
  };
}
