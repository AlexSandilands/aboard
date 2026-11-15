import { z } from "zod";

// Work a board has a connected machine do for a task it holds (docs/features/remote-machines.md#work-on-the-machine):
// a headless run, a custom automation's command or script. The board starts a job and reads it until it ends; the
// machine keeps it in memory, so a machine that restarts has forgotten it and the board fails the run.

export const MACHINE_JOBS_PATH = "/machine/jobs";
/** `GET`: a job's state. `DELETE`: the board has the outcome, so the machine may forget it. */
export const machineJobPath = (jobId: string): string => `${MACHINE_JOBS_PATH}/${encodeURIComponent(jobId)}`;
/** `PUT`: the settings of the board the machine works by (which model reviews, how many rounds). */
export const MACHINE_SETTINGS_PATH = "/machine/settings";
/** `POST`: a page of the transcript of a session that ran on the machine. */
export const MACHINE_TRANSCRIPT_PATH = "/machine/transcript";
/** `PUT /machine/attachments/:id`: one of a held task's pasted images, sent with the hand-over. */
export const MACHINE_ATTACHMENTS_PATH = "/machine/attachments";
export const machineAttachmentPath = (id: string): string => `${MACHINE_ATTACHMENTS_PATH}/${encodeURIComponent(id)}`;

export const MachineJobKind = z.enum(["run", "shell", "script"]);
export type MachineJobKind = z.infer<typeof MachineJobKind>;

/** `POST /machine/jobs`. Sending the same id again starts nothing: the answer is the job as it stands. */
export const MachineJobRequest = z.object({
  /** The board's id for the job (a run's id), so a request sent twice starts one job. */
  id: z.string().min(1),
  kind: z.string(),
  /** The held task the job is for. */
  taskId: z.string().min(1),
  params: z.unknown(),
});
export type MachineJobRequest = z.infer<typeof MachineJobRequest>;

/** Why a job failed. `name` and the fields after it carry the errors a board's automations branch on. */
export const MachineJobError = z.object({
  message: z.string(),
  name: z.string().optional(),
  head: z.string().optional(),
  moved: z.boolean().optional(),
});
export type MachineJobError = z.infer<typeof MachineJobError>;

export const MachineJobState = z.object({
  id: z.string(),
  /** `unknown`: the machine has no such job (it restarted since, or never got it). */
  state: z.enum(["running", "done", "failed", "unknown"]),
  /** What the job recorded as it went (a run's session, worktree, model), after the `after` asked for. */
  updates: z.array(z.object({ seq: z.number().int().positive(), patch: z.record(z.string(), z.unknown()) })),
  result: z.unknown().optional(),
  error: MachineJobError.optional(),
});
export type MachineJobState = z.infer<typeof MachineJobState>;

/** `GET /machine/jobs/:id?after=<seq>&wait=<ms>`. */
export const MachineJobQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  wait: z.coerce.number().int().min(0).max(25_000).default(0),
});
export type MachineJobQuery = z.infer<typeof MachineJobQuery>;

/** `PUT /machine/settings`: the board's settings a machine works by, as the board has them. Unknown keys are dropped. */
export const MachineSettingsInput = z.object({ settings: z.record(z.string(), z.unknown()) });
export type MachineSettingsInput = z.infer<typeof MachineSettingsInput>;

/** `POST /machine/transcript`: a session that ran on the machine, by its id and the folder it ran in. */
export const MachineTranscriptRequest = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
});
export type MachineTranscriptRequest = z.infer<typeof MachineTranscriptRequest>;
