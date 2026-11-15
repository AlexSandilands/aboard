import { z } from "zod";
import { AgentHarness } from "./agentSessions.ts";
import { AutopilotRun } from "./autopilot.ts";
import { ModelChoice } from "./modelProfiles.ts";
import { SuggestedModel } from "./modelTiers.ts";
import { FindingSeverity, FindingStatus, ReviewRoundStatus, ReviewTrigger } from "./reviews.ts";
import { NotificationKind } from "./notifications.ts";
import {
  AttentionRequest,
  DueDate,
  EpicDelivery,
  LinkKind,
  StepStatus,
  TaskKind,
  TaskResolution,
  TaskStatus,
} from "./schemas.ts";

// Working copies and their change log (docs/features/remote-machines.md#held-tasks): what a board (bridge) and a
// runner exchange about a task the runner holds. The board owns the task; the runner holds a copy of it, orders
// every change to it, and records each as an entry the board applies.

export const MACHINE_TASKS_PATH = "/machine/tasks";
export const MACHINE_CHANGES_PATH = "/machine/changes";
export const MACHINE_EDITS_PATH = "/machine/edits";
export const MACHINE_REPLIES_PATH = "/machine/replies";
/**
 * `PUT`: the tasks the held ones point at, as the board has them now: a blocker finishing on the board is what lets
 * the machine's Autopilot start the task it blocked.
 */
export const MACHINE_REFERENCES_PATH = "/machine/references";
/** `DELETE`: the board taking a task back. */
export const machineTaskPath = (taskId: string): string => `${MACHINE_TASKS_PATH}/${encodeURIComponent(taskId)}`;

/**
 * The format this version writes log entries in. A runner can hold days of entries while the board updates itself,
 * so **a board reads every format ever written**: raising this needs an upgrader in `CHANGE_LOG_UPGRADERS` from the
 * format before, and the old format's test fixture stays (`workingCopies.test.ts`).
 */
export const CHANGE_LOG_FORMAT = 2;

/** The task's own fields a runner orders changes to. What the board keeps to itself is in remote-machines.md. */
export const CopiedTaskFields = z.object({
  title: z.string(),
  description: z.string().nullable(),
  planContext: z.string().nullable(),
  status: TaskStatus,
  statusChangedAt: z.string(),
  updatedAt: z.string(),
  resolution: TaskResolution.nullable(),
  resolvedByTaskId: z.string().nullable(),
  autoReview: z.boolean().nullable(),
  reviewModel: ModelChoice.nullable(),
  autopilot: z.boolean().nullable(),
  autoMerge: z.boolean().nullable(),
  priority: z.boolean(),
  manual: z.boolean(),
  dueDate: DueDate.nullable(),
  attentionRequest: AttentionRequest.nullable(),
  suggestedModel: SuggestedModel.nullable(),
});
export type CopiedTaskFields = z.infer<typeof CopiedTaskFields>;

export const CopiedStep = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: StepStatus,
  position: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type CopiedStep = z.infer<typeof CopiedStep>;

export const CopiedPhase = z.object({
  id: z.string(),
  title: z.string(),
  position: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  steps: z.array(CopiedStep),
});
export type CopiedPhase = z.infer<typeof CopiedPhase>;

/** A link as stored, without what a poller read of it: each side polls for itself. */
export const CopiedLink = z.object({
  id: z.string(),
  kind: LinkKind,
  url: z.string(),
  label: z.string().nullable(),
  /** The stored ref, as JSON text. */
  ref: z.string().nullable(),
  createdAt: z.string(),
  auto: z.boolean(),
  /**
   * An agent session's status and title as last read, as JSON text. Only for a session that ran on a machine (its
   * ref names one): its files are there, so the board can't read them and takes the machine's word.
   */
  snapshot: z.string().nullable().optional(),
});
export type CopiedLink = z.infer<typeof CopiedLink>;

/** An activity entry without its id, which each database gives its own. */
export const CopiedEvent = z.object({
  at: z.string(),
  actor: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type CopiedEvent = z.infer<typeof CopiedEvent>;

export const CopiedFinding = z.object({
  id: z.string(),
  position: z.number().int(),
  severity: FindingSeverity,
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  title: z.string(),
  body: z.string().nullable(),
  suggestion: z.string().nullable(),
  status: FindingStatus,
  resolutionNote: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CopiedFinding = z.infer<typeof CopiedFinding>;

/** A local review round with its findings: opened and run where the task is held, shown on the board. */
export const CopiedReview = z.object({
  id: z.string(),
  round: z.number().int(),
  cycle: z.number().int(),
  status: ReviewRoundStatus,
  trigger: ReviewTrigger,
  openedBy: z.string(),
  reviewer: z.string().nullable(),
  skill: z.string().nullable(),
  headSha: z.string().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  nudgedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  findings: z.array(CopiedFinding),
});
export type CopiedReview = z.infer<typeof CopiedReview>;

/**
 * Tokens a session or a run on the machine used for the task: one stored bucket (a file of a session, a local day, a
 * model), whole, so writing it twice changes nothing.
 */
export const CopiedUsage = z.object({
  harness: AgentHarness,
  sessionId: z.string(),
  sourceFile: z.string(),
  day: z.string(),
  model: z.string(),
  source: z.enum(["transcript", "run_output"]),
  /** Set for a run's own usage (the reviewer's), which no session link leads to. */
  ofTask: z.boolean(),
  purpose: z.string().nullable(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite5m: z.number(),
    cacheWrite1h: z.number(),
    requests: z.number().optional(),
  }),
  reportedCostUsd: z.number().nullable(),
});
export type CopiedUsage = z.infer<typeof CopiedUsage>;

/** Everything of a task a runner orders: after each change, the whole of it. */
export const TaskState = z.object({
  task: CopiedTaskFields,
  labels: z.array(z.string()),
  phases: z.array(CopiedPhase),
  links: z.array(CopiedLink),
  /** Ids of the tasks blocking this one, and of those it blocks. */
  blockedBy: z.array(z.string()),
  blocks: z.array(z.string()),
  /** The task's review rounds. Absent from a version that kept them out of the copy: the reader then leaves its own. */
  reviews: z.array(CopiedReview).optional(),
});
export type TaskState = z.infer<typeof TaskState>;

/** What never changes about a task. */
export const TaskIdentity = z.object({
  id: z.string(),
  numberPrefix: z.string(),
  number: z.number().int(),
  kind: TaskKind,
  createdBy: z.string(),
  createdAt: z.string(),
});
export type TaskIdentity = z.infer<typeof TaskIdentity>;

/**
 * A task the held one points at (its epic, a blocker, the task it was closed against) that the runner doesn't hold:
 * enough to show it and to tell whether it still blocks. A runner never changes one.
 */
export const TaskReference = z.object({
  id: z.string(),
  numberPrefix: z.string(),
  number: z.number().int(),
  kind: TaskKind,
  title: z.string(),
  status: TaskStatus,
  archived: z.boolean(),
  /** An epic's delivery and integration branch, which its tasks start from and open their pull requests against. */
  delivery: EpicDelivery.nullable().optional(),
  integrationBranch: z.string().nullable().optional(),
});
export type TaskReference = z.infer<typeof TaskReference>;

/** A project as a runner needs it: the board's id for it, and the repository it is, by its remote. */
export const CopiedProject = z.object({
  id: z.string(),
  title: z.string(),
  /** The URL to clone from, as the board's checkout has it; null for a project with no repository. */
  remoteUrl: z.string().nullable(),
  /** `host/owner/repo`, lower case: what makes two checkouts the same project, whatever their paths. */
  remote: z.string().nullable(),
});
export type CopiedProject = z.infer<typeof CopiedProject>;

export const ChangeLogKind = z.enum(["state", "created", "released", "run", "notice"]);
export type ChangeLogKind = z.infer<typeof ChangeLogKind>;

const StatePayload = z.object({
  state: TaskState,
  events: z.array(CopiedEvent),
  /** What the task's sessions and runs on the machine have used so far; absent when the entry says nothing of it. */
  usage: z.array(CopiedUsage).optional(),
});
const CreatedPayload = StatePayload.extend({
  identity: TaskIdentity,
  project: CopiedProject,
  /** The epic the task was put in, when the runner knows one. */
  epicId: z.string().nullable(),
  references: z.array(TaskReference),
});

/**
 * A run the machine's own Autopilot made (format 2), whole as it stands after the change: the board keeps it under
 * the same id, tagged with the machine. `projectId` is the board's id for the project.
 */
const RunPayload = z.object({ run: AutopilotRun });

/** A notification the machine raised (format 2): the board raises it in its own inbox, by its own switches. */
const NoticePayload = z.object({
  notice: z.object({
    kind: NotificationKind,
    taskId: z.string().nullable(),
    title: z.string(),
    body: z.string(),
    dedupeKey: z.string(),
  }),
});

/** A log entry in the current format. */
export const ChangeLogEntry = z.discriminatedUnion("kind", [
  /** The task as it is after a change, with the activity the change logged. */
  z.object({ kind: z.literal("state"), ...entryBase(), payload: StatePayload }),
  /** A task made on the runner: the board creates it, held by that machine. */
  z.object({
    kind: z.literal("created"),
    ...entryBase(),
    payload: CreatedPayload,
  }),
  /** The task's last state as the runner gives it back; the board holds it again once this is applied. */
  z.object({
    kind: z.literal("released"),
    ...entryBase(),
    payload: StatePayload,
  }),
  /** A run of the machine's Autopilot, as it now stands. `taskId` is its task's, or "" for a run with none. */
  z.object({ kind: z.literal("run"), ...entryBase(), payload: RunPayload }),
  /** A notification the machine raised. `taskId` as for a run. */
  z.object({
    kind: z.literal("notice"),
    ...entryBase(),
    payload: NoticePayload,
  }),
]);
export type ChangeLogEntry = z.infer<typeof ChangeLogEntry>;

function entryBase() {
  return {
    /** The runner's own counter: entries apply in this order, each once. */
    id: z.number().int().positive(),
    taskId: z.string(),
    at: z.string(),
  };
}

/** An entry as it travels and is stored: the payload is read by `readChangeLogEntry`, by its `version`. */
export const StoredChangeLogEntry = z.object({
  id: z.number().int().positive(),
  version: z.number().int().positive(),
  kind: z.string(),
  taskId: z.string(),
  at: z.string(),
  payload: z.unknown(),
});
export type StoredChangeLogEntry = z.infer<typeof StoredChangeLogEntry>;

/**
 * One step per format: `CHANGE_LOG_UPGRADERS[n]` turns a stored entry of format `n` into format `n + 1`. Never
 * remove one: a runner that was offline for a week still sends the old format.
 */
export const CHANGE_LOG_UPGRADERS: Readonly<Record<number, (entry: StoredChangeLogEntry) => StoredChangeLogEntry>> = {
  // Format 2 added the `run` and `notice` kinds; the kinds format 1 had are unchanged.
  1: (entry) => entry,
};

export class ChangeLogFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeLogFormatError";
  }
}

/**
 * A stored entry in the current format, whatever format it was written in. Throws `ChangeLogFormatError` for a
 * format newer than this version knows (the runner is ahead: the board has to update) or an entry it can't read.
 */
export function readChangeLogEntry(stored: StoredChangeLogEntry): ChangeLogEntry {
  if (stored.version > CHANGE_LOG_FORMAT) {
    throw new ChangeLogFormatError(
      `Log entry ${stored.id} is in format ${stored.version}; this version reads up to ${CHANGE_LOG_FORMAT}`,
    );
  }
  let entry = stored;
  while (entry.version < CHANGE_LOG_FORMAT) {
    const upgrade = CHANGE_LOG_UPGRADERS[entry.version];
    if (!upgrade) throw new ChangeLogFormatError(`No reader for log format ${entry.version}`);
    entry = { ...upgrade(entry), version: entry.version + 1 };
  }
  const parsed = ChangeLogEntry.safeParse(entry);
  if (!parsed.success) {
    throw new ChangeLogFormatError(`Log entry ${stored.id} can't be read: ${parsed.error.issues[0]?.message ?? ""}`);
  }
  return parsed.data;
}

/** `POST /machine/tasks`: the board handing a task over. */
export const HandOverRequest = z.object({
  identity: TaskIdentity,
  project: CopiedProject,
  epicId: z.string().nullable(),
  state: TaskState,
  /** The task's recent activity, oldest first, so an agent on the runner reads the same handover notes. */
  events: z.array(CopiedEvent),
  references: z.array(TaskReference),
});
export type HandOverRequest = z.infer<typeof HandOverRequest>;

/** `PUT /machine/references`. */
export const ReferencesUpdate = z.object({
  references: z.array(TaskReference),
});
export type ReferencesUpdate = z.infer<typeof ReferencesUpdate>;

/** The runner's log position: what the board has applied once it reaches `head`. */
export const LogPosition = z.object({ head: z.number().int().nonnegative() });
export type LogPosition = z.infer<typeof LogPosition>;

/** What a runner may ask of its board, carried back on the board's own poll: a runner never dials out. */
export const BridgeRequestMethod = z.enum(["allocateNumber", "callTool"]);
export type BridgeRequestMethod = z.infer<typeof BridgeRequestMethod>;

export const BridgeRequest = z.object({
  id: z.string(),
  method: z.string(),
  params: z.unknown(),
});
export type BridgeRequest = z.infer<typeof BridgeRequest>;

/** `POST /machine/replies`: the board's answer to a `BridgeRequest`. */
export const BridgeReply = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type BridgeReply = z.infer<typeof BridgeReply>;

/** A tool call a runner passes to its board, for a task it doesn't hold. */
export const CallToolParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  actor: z.string().optional(),
});
export type CallToolParams = z.infer<typeof CallToolParams>;

export const CallToolReply = z.object({
  text: z.string(),
  isError: z.boolean(),
});
export type CallToolReply = z.infer<typeof CallToolReply>;

/** `GET /machine/changes?after=<id>&wait=<ms>`: the query. */
export const ChangesQuery = z.object({
  /** The last entry the board applied: everything up to it is dropped from the runner's log. */
  after: z.coerce.number().int().nonnegative().default(0),
  /** How long to hold the answer while there is nothing to say, at most 25 seconds. */
  wait: z.coerce.number().int().min(0).max(25_000).default(0),
  /** The log the cursor belongs to; a runner whose log is another one starts the board from the beginning. */
  epoch: z.string().optional(),
  /** The machine's prefix on this board and the highest number the board has seen it give out. */
  prefix: z.string().optional(),
  counter: z.coerce.number().int().nonnegative().optional(),
});
export type ChangesQuery = z.infer<typeof ChangesQuery>;

export const ChangesResponse = z.object({
  /** Names this runner's log: a new one after its database was replaced, when its ids start again. */
  epoch: z.string(),
  head: z.number().int().nonnegative(),
  entries: z.array(StoredChangeLogEntry),
  requests: z.array(BridgeRequest),
  /** Ids of every task the runner holds now. */
  held: z.array(z.string()),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

/** The edits a board passes on for a task a machine holds. Each names a service call; `args` are its arguments. */
export const HeldEditOp = z.enum([
  "tasks.update",
  "tasks.move",
  "tasks.close",
  "tasks.addNote",
  "plans.setPlan",
  "plans.updatePlan",
  "plans.addPhase",
  "plans.updatePhase",
  "plans.deletePhase",
  "plans.addSteps",
  "plans.updateStep",
  "plans.moveStep",
  "plans.deleteStep",
  "links.add",
  "links.remove",
  "links.unlink",
  "attention.request",
  "attention.clear",
  "reviews.openRound",
  "reviews.submit",
  "reviews.resolveFinding",
]);
export type HeldEditOp = z.infer<typeof HeldEditOp>;

/** `POST /machine/edits`: one edit made on the board to a task the runner holds. */
export const HeldEditRequest = z.object({
  /** The board's id for the edit, so one sent twice is applied once. */
  id: z.string(),
  taskId: z.string(),
  op: HeldEditOp,
  args: z.array(z.unknown()),
  /** The ids the board gave what the edit made (steps, links), in order, so both sides name them the same. */
  ids: z.array(z.string()),
  /** Tasks the edit points at that the runner may not have. */
  references: z.array(TaskReference),
});
export type HeldEditRequest = z.infer<typeof HeldEditRequest>;

export const HeldEditResult = z.object({
  /** False when the runner refused the edit as the task stands there; `error` says why. */
  applied: z.boolean(),
  error: z.string().nullable(),
  /** The log position that carries the edit's outcome. */
  head: z.number().int().nonnegative(),
});
export type HeldEditResult = z.infer<typeof HeldEditResult>;

/** `POST /api/tasks/:id/hold`. */
export const HandOverInput = z.object({ machineId: z.string().min(1) });
export type HandOverInput = z.infer<typeof HandOverInput>;

/** `DELETE /api/tasks/:id/hold`. */
export const ReleaseInput = z.object({
  /** Take the task back without the machine: what it changed and the board hasn't seen is lost. */
  force: z.boolean().optional(),
});
export type ReleaseInput = z.infer<typeof ReleaseInput>;
