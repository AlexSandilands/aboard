import type { MachineJobError, MachineJobRequest, MachineJobState } from "@repo/contracts";
import { WorktreeHeadError } from "../../autopilot/types.ts";
import { messageOf } from "../util.ts";

// A runner's jobs (docs/features/remote-machines.md#work-on-the-machine): work its board asked for on a task held
// here, such as a headless run or a custom automation's script. A job runs in the background while the board reads
// its state; it lives in memory, so a runner that restarts has none, and the board fails the run it was waiting on.

/** How long a finished job is kept for a board that hasn't read its outcome yet. */
const KEEP_FINISHED_MS = 6 * 60 * 60_000;

export type JobUpdate = (patch: Record<string, unknown>) => void;
/** Does a job's work, reporting what it records as it goes; what it returns is the job's result. */
export type JobHandler = (request: MachineJobRequest, update: JobUpdate) => Promise<unknown>;

export interface MachineJobs {
  /** Starts the job unless one with its id is known, and returns it as it stands. */
  start(request: MachineJobRequest, handler: JobHandler): MachineJobState;
  /** The job with its updates after `after`, waiting up to `wait` ms while it is running and has none. */
  read(id: string, after: number, wait: number): Promise<MachineJobState>;
  /** Drops a finished job: the board has its outcome. A running one is kept. */
  forget(id: string): void;
  /** Jobs still going. */
  inFlight(): number;
}

interface Job {
  id: string;
  state: "running" | "done" | "failed";
  updates: Array<{ seq: number; patch: Record<string, unknown> }>;
  result?: unknown;
  error?: MachineJobError;
  finishedAt: number | null;
  waiters: Set<() => void>;
}

/** An error as it travels: the ones a board's automations branch on keep what they carry. */
export function jobError(error: unknown): MachineJobError {
  if (error instanceof WorktreeHeadError) {
    return { message: error.message, name: error.name, head: error.head, moved: error.moved };
  }
  return { message: messageOf(error), ...(error instanceof Error ? { name: error.name } : {}) };
}

/** The error a job failed with, as the board's code throws it. */
export function reviveJobError(error: MachineJobError | undefined): Error {
  if (error?.name === "WorktreeHeadError" && error.head !== undefined) {
    return new WorktreeHeadError(error.message, error.head, error.moved ?? false);
  }
  return new Error(error?.message ?? "The machine's job failed");
}

export function createMachineJobs(deps: { now?: () => number } = {}): MachineJobs {
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, Job>();

  const stateOf = (job: Job, after: number): MachineJobState => ({
    id: job.id,
    state: job.state,
    updates: job.updates.filter((u) => u.seq > after),
    ...(job.state === "done" ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });

  const wake = (job: Job): void => {
    for (const done of job.waiters) done();
  };

  const prune = (): void => {
    for (const [id, job] of jobs) {
      if (job.finishedAt !== null && now() - job.finishedAt > KEEP_FINISHED_MS) jobs.delete(id);
    }
  };

  return {
    start(request, handler) {
      prune();
      const known = jobs.get(request.id);
      if (known) return stateOf(known, 0);
      const job: Job = { id: request.id, state: "running", updates: [], finishedAt: null, waiters: new Set() };
      jobs.set(job.id, job);
      const update: JobUpdate = (patch) => {
        if (job.state !== "running") return;
        job.updates.push({ seq: job.updates.length + 1, patch });
        wake(job);
      };
      void (async () => {
        try {
          // Awaited first, so the board has its answer before the work begins.
          await Promise.resolve();
          job.result = (await handler(request, update)) ?? null;
          job.state = "done";
        } catch (error) {
          job.state = "failed";
          job.error = jobError(error);
        }
        job.finishedAt = now();
        wake(job);
      })();
      return stateOf(job, 0);
    },

    async read(id, after, wait) {
      const job = jobs.get(id);
      if (!job) return { id, state: "unknown", updates: [] };
      const nothingNew = () => job.state === "running" && !job.updates.some((u) => u.seq > after);
      if (wait > 0 && nothingNew()) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            job.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          timer.unref();
          job.waiters.add(done);
        });
      }
      return stateOf(job, after);
    },

    forget(id) {
      if (jobs.get(id)?.state !== "running") jobs.delete(id);
    },

    inFlight: () => [...jobs.values()].filter((job) => job.state === "running").length,
  };
}
