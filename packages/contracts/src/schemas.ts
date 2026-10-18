import { z } from "zod";
import { AutopilotStatus } from "./autopilot.ts";
import { KeybindingOverrides } from "./keybindings.ts";
import { LabelHue } from "./labels.ts";
import { AgentSessionRef, AgentSessionSnapshot, TerminalOpenIn, TerminalSetting } from "./agentSessions.ts";
import { BackupSettings } from "./backup.ts";
import { ModelTiers, SuggestedModel, SuggestedModelInput } from "./modelTiers.ts";
import { InboxNotification, NotificationSettings, UpdateNotificationSettingsInput } from "./notifications.ts";
import { PlanSkillRef, ReviewSkillRef, TaskReview, TaskReviewSummary } from "./reviews.ts";
import { SavedViews } from "./savedViews.ts";

// ── Enums ────────────────────────────────────────────────────────────────

export const TaskStatus = z.enum(["backlog", "planned", "in_progress", "review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * TaskStatus for inputs. The first column used to be "idea"; agents with older instructions still send it, so
 * it is read as "backlog". Outputs never say "idea".
 */
export const TaskStatusInput = z.preprocess((value) => (value === "idea" ? "backlog" : value), TaskStatus);

export const TASK_STATUSES: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

/**
 * Why a task is closed, separate from its status. Set only by closing a task, which also moves it to Done;
 * moving the task out of Done clears it.
 */
export const TaskResolution = z.enum(["completed", "duplicate", "wont_do"]);
export type TaskResolution = z.infer<typeof TaskResolution>;

/** Resolutions that point at the task that delivered (or duplicates) the closed one. */
export const resolutionNeedsTask = (resolution: TaskResolution): boolean => resolution !== "wont_do";

/**
 * A task is a card with a plan; an epic groups child tasks. An epic has no plan, and its status follows its
 * children (see deriveEpicStatus). Epics don't nest.
 */
export const TaskKind = z.enum(["task", "epic"]);
export type TaskKind = z.infer<typeof TaskKind>;

/**
 * How an epic's tasks are delivered. `main`: each task opens a pull request to the default branch, which the user
 * merges. `integration`: the epic has a branch of its own; its tasks start from it and open their pull requests
 * against it, Autopilot merges those there, and the user merges the epic's pull request into the default branch.
 */
export const EpicDelivery = z.enum(["main", "integration"]);
export type EpicDelivery = z.infer<typeof EpicDelivery>;

export const StepStatus = z.enum(["todo", "in_progress", "done", "blocked", "skipped"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const LinkKind = z.enum(["pr", "jira", "t3_thread", "issue", "agent_session", "url"]);
export type LinkKind = z.infer<typeof LinkKind>;

export const PROJECT_ICON_COLORS = [
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;
export const ProjectIconColor = z.enum(PROJECT_ICON_COLORS);
export type ProjectIconColor = z.infer<typeof ProjectIconColor>;

/** Edge length, in px, that uploaded icon images are resampled to. */
export const PROJECT_ICON_IMAGE_SIZE = 128;
/** Longest accepted image icon data URL (~96 KB of base64). */
export const PROJECT_ICON_IMAGE_MAX_LENGTH = 128_000;

export const ProjectIcon = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("lucide"),
    name: z
      .string()
      .max(64)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    color: ProjectIconColor,
  }),
  z.object({ kind: z.literal("emoji"), emoji: z.string().trim().min(1).max(32) }),
  z.object({
    kind: z.literal("monogram"),
    text: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}‌‍]*$/u),
    color: ProjectIconColor,
  }),
  // Inline so icons travel with the project row over REST/SSE with no file route or cleanup. The
  // picker downscales to PROJECT_ICON_IMAGE_SIZE, so the cap only stops oversized hand-made values.
  // Raster only: SVG can carry script and isn't needed once the image has been resampled.
  z.object({
    kind: z.literal("image"),
    dataUrl: z
      .string()
      .max(PROJECT_ICON_IMAGE_MAX_LENGTH)
      .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
  }),
]);
export type ProjectIcon = z.infer<typeof ProjectIcon>;

const IsoDate = z.string();

// ── Entities ─────────────────────────────────────────────────────────────

export const Project = z.object({
  id: z.string(),
  title: z.string(),
  workspaceRoot: z.string().nullable(),
  workspaceKey: z.string().nullable(),
  icon: ProjectIcon.nullable(),
  t3ProjectId: z.string().nullable(),
  /** Overrides the global review skill for this project's tasks; null inherits it. */
  reviewSkill: ReviewSkillRef.nullable(),
  /** Overrides the global planning skill for this project's bulk-planning sessions; null inherits it. */
  planSkill: PlanSkillRef.nullable(),
  position: z.string(),
  collapsed: z.boolean(),
  archivedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});
export type Project = z.infer<typeof Project>;

export const PlanStep = z.object({
  id: z.string(),
  phaseId: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  status: StepStatus,
  position: z.string(),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  updatedAt: IsoDate,
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanPhase = z.object({
  id: z.string(),
  title: z.string(),
  position: z.string(),
  steps: z.array(PlanStep),
});
export type PlanPhase = z.infer<typeof PlanPhase>;

export const PrRef = z.object({ host: z.string(), repo: z.string(), number: z.number().int() });
export type PrRef = z.infer<typeof PrRef>;

/** A GitHub issue. Shaped like a PR ref, since both live at `<host>/<owner>/<repo>/<kind>/<n>`. */
export const IssueRef = z.object({ host: z.string(), repo: z.string(), number: z.number().int() });
export type IssueRef = z.infer<typeof IssueRef>;

/** What was last read of a GitHub issue when it was imported. It isn't polled afterwards. */
export const IssueSnapshot = z.object({
  state: z.enum(["open", "closed"]),
  title: z.string(),
});
export type IssueSnapshot = z.infer<typeof IssueSnapshot>;

export const MergeMethod = z.enum(["squash", "merge", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethod>;

/** A review on a pull request, as the poll last read it. */
export const PrReviewInfo = z.object({
  /** GitHub's databaseId, as Autopilot's review runs record it. */
  id: z.number().int().nullable(),
  author: z.string().nullable(),
  state: z.enum(["approved", "changes_requested", "commented", "dismissed"]),
  submittedAt: IsoDate.nullable(),
  /** Written by the signed-in `gh` account, which is also the account Autopilot posts as. */
  own: z.boolean(),
  /** The author is an owner, member or collaborator of the repository. */
  trusted: z.boolean(),
});
export type PrReviewInfo = z.infer<typeof PrReviewInfo>;

/** An inline review comment on a thread that isn't resolved. No body: the snapshot only says who wrote what when. */
export const PrReviewCommentInfo = z.object({
  id: z.number().int(),
  author: z.string().nullable(),
  createdAt: IsoDate,
  /** The review the comment was posted in (every inline comment is in one). */
  reviewId: z.number().int().nullable(),
  own: z.boolean(),
  trusted: z.boolean(),
});
export type PrReviewCommentInfo = z.infer<typeof PrReviewCommentInfo>;

export const PrSnapshot = z.object({
  state: z.enum(["open", "draft", "merged", "closed"]),
  title: z.string(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  reviewDecision: z.enum(["approved", "changes_requested", "review_required"]).nullable(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  headRef: z.string().nullable(),
  /** The branch the PR merges into. Optional so snapshots stored before it was read still parse. */
  baseRef: z.string().nullable().optional(),
  updatedAt: IsoDate.nullable(),
  // Optional so snapshots stored by the gh poller, before merging existed, still parse.
  /** The method auto-merge is set to merge with, or null when auto-merge is off. */
  autoMerge: MergeMethod.nullable().optional(),
  /** Methods the repo allows, in GitHub's order. */
  mergeMethods: z.array(MergeMethod).optional(),
  /** Whether the repo lets auto-merge be turned on. */
  autoMergeAllowed: z.boolean().optional(),
  /** Whether the signed-in account can push to the repo, and so merge. */
  canMerge: z.boolean().optional(),
  headOid: z.string().nullable().optional(),
  /** Whether the head branch is in another repository (a fork), so not on the base repo's `origin`. */
  isCrossRepository: z.boolean().optional(),
  /** The newest reviews, oldest first. Optional, as below, so older snapshots still parse. */
  reviews: z.array(PrReviewInfo).optional(),
  /** Comments on the newest unresolved review threads, oldest first. */
  reviewComments: z.array(PrReviewCommentInfo).optional(),
});
export type PrSnapshot = z.infer<typeof PrSnapshot>;

/**
 * When the board saw each pull request fact begin, from one snapshot to the next (`nextPrChanges`): the merge, the
 * checks starting to fail, a conflict appearing, and the head moving from one commit to another. Server-side only,
 * for Autopilot's PR triggers; the snapshot alone can't say when a state began.
 */
export const PrChanges = z.object({
  merged: IsoDate.optional(),
  checksFailing: IsoDate.optional(),
  conflict: IsoDate.optional(),
  newHead: IsoDate.optional(),
  /** The last known checks and mergeability, kept across `pending` and `unknown`, which say nothing either way. */
  failing: z.boolean().optional(),
  conflicting: z.boolean().optional(),
});
export type PrChanges = z.infer<typeof PrChanges>;

/**
 * The PR changes after a new snapshot at `at`. A fact that became true is stamped; one that holds keeps its stamp.
 * The first snapshot (`prev` null: the PR was just linked, or the board was restored, which leaves snapshots out)
 * only records what is true, so a state the board finds already in place never counts as beginning. Pending checks
 * and unknown mergeability keep the last known state, so a push that re-runs failing checks, or GitHub recomputing
 * a conflict, isn't a new failure or conflict.
 */
export function nextPrChanges(
  prev: PrSnapshot | null,
  next: PrSnapshot | null,
  changes: PrChanges,
  at: string,
): PrChanges {
  if (!next) return changes;
  const out: PrChanges = { ...changes };
  const failing = next.checks === "pending" ? undefined : next.checks === "failing";
  const conflicting = next.mergeable === "unknown" ? undefined : next.mergeable === "conflicting";
  if (!prev) {
    if (failing !== undefined) out.failing = failing;
    if (conflicting !== undefined) out.conflicting = conflicting;
    return out;
  }
  // Rows from before these flags fall back to the previous snapshot.
  const wasFailing = changes.failing ?? prev.checks === "failing";
  const wasConflicting = changes.conflicting ?? prev.mergeable === "conflicting";
  if (next.state === "merged" && prev.state !== "merged") out.merged = at;
  if (failing !== undefined) {
    if (failing && !wasFailing) out.checksFailing = at;
    out.failing = failing;
  }
  if (conflicting !== undefined) {
    if (conflicting && !wasConflicting) out.conflict = at;
    out.conflicting = conflicting;
  }
  if (prev.headOid && next.headOid && prev.headOid !== next.headOid) out.newHead = at;
  return out;
}

export const T3ThreadRef = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});
export type T3ThreadRef = z.infer<typeof T3ThreadRef>;

export const T3ThreadStatus = z.enum(["working", "waiting", "input", "approval", "failed", "done", "idle"]);
export type T3ThreadStatus = z.infer<typeof T3ThreadStatus>;

// Fields after `status` are optional so snapshots stored before they existed still parse.
export const T3ThreadSnapshot = z.object({
  title: z.string(),
  status: T3ThreadStatus,
  settled: z.boolean().optional(),
  archived: z.boolean().optional(),
  lastActivityAt: IsoDate.nullable().optional(),
  model: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
});
export type T3ThreadSnapshot = z.infer<typeof T3ThreadSnapshot>;

const LinkBase = {
  id: z.string(),
  taskId: z.string(),
  url: z.string(),
  label: z.string().nullable(),
  syncedAt: IsoDate.nullable(),
  createdAt: IsoDate,
};

export const TaskLink = z.discriminatedUnion("kind", [
  z.object({ ...LinkBase, kind: z.literal("pr"), ref: PrRef.nullable(), snapshot: PrSnapshot.nullable() }),
  z.object({ ...LinkBase, kind: z.literal("jira"), ref: z.object({ key: z.string() }) }),
  z.object({
    ...LinkBase,
    kind: z.literal("t3_thread"),
    ref: T3ThreadRef,
    snapshot: T3ThreadSnapshot.nullable(),
  }),
  z.object({ ...LinkBase, kind: z.literal("issue"), ref: IssueRef, snapshot: IssueSnapshot.nullable() }),
  z.object({
    ...LinkBase,
    kind: z.literal("agent_session"),
    ref: AgentSessionRef,
    snapshot: AgentSessionSnapshot.nullable(),
    /** The Windows Terminal window the board started the session in, so it can bring it back; else absent. */
    window: z.string().nullish(),
  }),
  z.object({ ...LinkBase, kind: z.literal("url") }),
]);
export type TaskLink = z.infer<typeof TaskLink>;

export const AttentionReason = z.object({
  kind: z.enum([
    "blocked_step",
    "pr_checks_failing",
    "pr_changes_requested",
    "pr_conflict",
    "thread_needs_input",
    "thread_failed",
    "review_stalled",
    "review_stuck",
    "review_failed",
    "review_unattended",
    "import_failed",
    "autopilot",
    "agent_request",
  ]),
  severity: z.enum(["warning", "error"]),
  message: z.string(),
});
export type AttentionReason = z.infer<typeof AttentionReason>;

/** An agent's standing request for the user to look at a task (the request_attention tool). */
export const AttentionRequest = z.object({
  /** What the user should look at. */
  message: z.string(),
  /** Who asked: the agent's label. */
  actor: z.string(),
  requestedAt: IsoDate,
});
export type AttentionRequest = z.infer<typeof AttentionRequest>;

export const CurrentStep = z.object({
  id: z.string(),
  title: z.string(),
  phaseTitle: z.string(),
  status: StepStatus,
  /** 1-based "phase.step" label, e.g. "2.3". */
  index: z.string(),
});
export type CurrentStep = z.infer<typeof CurrentStep>;

export const TaskEvent = z.object({
  id: z.number().int(),
  taskId: z.string(),
  at: IsoDate,
  actor: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type TaskEvent = z.infer<typeof TaskEvent>;

export const ImportStatus = z.enum(["pending", "failed", "done"]);
export type ImportStatus = z.infer<typeof ImportStatus>;

/** A task created from a Jira or GitHub issue: the title, description and labels are filled in by a background job. */
export const TaskImport = z.object({
  status: ImportStatus,
  /** Why the last attempt failed; null unless the status is "failed". */
  error: z.string().nullable(),
  /** The Jira key or issue URL the task was created from. */
  sourceUrl: z.string(),
});
export type TaskImport = z.infer<typeof TaskImport>;

/** Compact pointer to another task, e.g. the one that resolved this one. */
export const TaskRef = z.object({ id: z.string(), number: z.number().int(), title: z.string() });
export type TaskRef = z.infer<typeof TaskRef>;

/** An epic's children counted by status. Archived children don't count; closed ones count as done. */
export const EpicRollup = z.object({
  total: z.number().int(),
  done: z.number().int(),
  byStatus: z.record(TaskStatus, z.number().int()),
});
export type EpicRollup = z.infer<typeof EpicRollup>;

/** The other end of a blocks / blocked-by relation: enough to show it, and to tell whether it still blocks. */
export const TaskRelation = TaskRef.extend({
  status: TaskStatus,
  /** An archived task that isn't Done still blocks, but its card isn't on the board. */
  archived: z.boolean(),
});
export type TaskRelation = z.infer<typeof TaskRelation>;

export const TaskSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  projectId: z.string(),
  kind: TaskKind,
  /** The epic this task belongs to; null for loose tasks and for epics. */
  parent: TaskRef.nullable(),
  /** Children counted by status; null unless this is an epic. */
  rollup: EpicRollup.nullable(),
  title: z.string(),
  status: TaskStatus,
  position: z.string(),
  archivedAt: IsoDate.nullable(),
  createdBy: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  statusChangedAt: IsoDate,
  /** Normalised labels (see normalizeLabel), sorted by name. */
  labels: z.array(z.string()),
  /** Tasks that must be Done before this one is ready, by number. */
  blockedBy: z.array(TaskRelation),
  /** Tasks waiting on this one, by number. */
  blocks: z.array(TaskRelation),
  /** True while any of `blockedBy` isn't Done (see isBlocked). */
  blocked: z.boolean(),
  resolution: TaskResolution.nullable(),
  /** The task that delivered or duplicates this one; null for "won't do" or once that task is deleted. */
  resolvedBy: TaskRef.nullable(),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  /** Per-step statuses in plan order, for segmented progress bars. */
  stepStatuses: z.array(StepStatus),
  currentStep: CurrentStep.nullable(),
  links: z.array(TaskLink),
  attention: z.array(AttentionReason),
  /** The agent's request behind an `agent_request` attention reason; null when no agent has one standing. */
  attentionRequest: AttentionRequest.nullable(),
  lastNote: z.object({ text: z.string(), actor: z.string(), at: IsoDate }).nullable(),
  /** Per-task auto-review override; null inherits the global setting. */
  autoReview: z.boolean().nullable(),
  /** Per-task Autopilot flag: null is Default, true is On, false is Off. Start planned tasks only starts tasks flagged On. */
  autopilot: z.boolean().nullable(),
  /**
   * Per-task auto-merge flag: null is Default (off), true is On, false is Off. Only On lets merge_task_pr merge the
   * task's PR into the default branch.
   */
  autoMerge: z.boolean().nullable(),
  /** True shows the task in the priority lane above every project; always false for an epic. */
  priority: z.boolean(),
  /** An epic's delivery; null for a task, and for an epic nobody chose one for yet (which delivers to main). */
  delivery: EpicDelivery.nullable(),
  /**
   * The integration branch: an epic's own while it uses integration delivery, and for a task in such an epic the same
   * branch, which the task starts from and opens its pull request against. Null otherwise.
   */
  integrationBranch: z.string().nullable(),
  /** Local review badge; null when the task has never been reviewed. */
  review: TaskReviewSummary.nullable(),
  /** The model tier its planner suggests for implementing it; null when none is set. */
  suggestedModel: SuggestedModel.nullable(),
  /** Set when the task was created from an issue URL; null otherwise. */
  import: TaskImport.nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskDetail = TaskSummary.extend({
  description: z.string().nullable(),
  planContext: z.string().nullable(),
  phases: z.array(PlanPhase),
  events: z.array(TaskEvent),
  /** Tasks closed as done by, or duplicates of, this one. */
  resolves: z.array(TaskRef.extend({ resolution: TaskResolution })),
  /** Local review rounds, oldest first, each with its findings. */
  reviews: z.array(TaskReview),
  /** An epic's children, archived ones included, in board order; empty for a task. */
  children: z.array(TaskSummary),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

export const T3IntegrationStatus = z.object({
  detected: z.boolean(),
  origin: z.string().nullable(),
  environmentId: z.string().nullable(),
  label: z.string().nullable(),
  liveStatus: z.enum(["off", "ok", "error"]),
  error: z.string().nullable(),
});
export type T3IntegrationStatus = z.infer<typeof T3IntegrationStatus>;

export const BoardSnapshot = z.object({
  projects: z.array(Project),
  tasks: z.array(TaskSummary),
  /** Label colour overrides by label; labels not listed take a hue hashed from their name. */
  labelColors: z.record(z.string(), LabelHue),
  integrations: z.object({ t3: T3IntegrationStatus }),
  autopilot: AutopilotStatus,
});
export type BoardSnapshot = z.infer<typeof BoardSnapshot>;

export const BoardEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.upserted"), project: Project }),
  z.object({ type: z.literal("project.deleted"), projectId: z.string() }),
  z.object({ type: z.literal("task.upserted"), task: TaskSummary }),
  z.object({ type: z.literal("task.deleted"), taskId: z.string() }),
  z.object({ type: z.literal("task.detail_changed"), taskId: z.string() }),
  z.object({ type: z.literal("integrations.changed"), t3: T3IntegrationStatus }),
  /** Label colours are board-wide, so a change is sent whole rather than per task. */
  z.object({ type: z.literal("labels.colors_changed"), labelColors: z.record(z.string(), LabelHue) }),
  /** A run started or finished, or Autopilot settings or pause changed. Sent whole: it is small and board-wide. */
  z.object({ type: z.literal("autopilot.changed"), autopilot: AutopilotStatus }),
  /**
   * Something worth the user's attention happened. `unread` counts every unread notification; `popup` is false when
   * quiet hours keep it to the inbox. The window shows the OS notification and badge from this.
   */
  z.object({
    type: z.literal("notification.created"),
    notification: InboxNotification,
    unread: z.number(),
    popup: z.boolean(),
  }),
  /** Notifications were read or removed (their task was deleted); the inbox refetches. */
  z.object({ type: z.literal("notifications.changed"), unread: z.number() }),
]);
export type BoardEvent = z.infer<typeof BoardEvent>;

// ── Inputs ───────────────────────────────────────────────────────────────

export const PlanStepInput = z.object({
  /** Existing step id — when present in set_plan, the step keeps its status/timestamps. */
  id: z.string().optional(),
  title: z.string().trim().min(1),
  notes: z.string().optional(),
  status: StepStatus.optional(),
});
export type PlanStepInput = z.infer<typeof PlanStepInput>;

export const PlanInput = z.object({
  context: z.string().optional(),
  /** Omit to keep the current suggestion; null clears it. */
  suggestedModel: SuggestedModelInput.nullable().optional(),
  phases: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().trim().min(1),
        steps: z.array(PlanStepInput),
      }),
    )
    .min(1),
});
export type PlanInput = z.infer<typeof PlanInput>;

export const CreateProjectInput = z.object({
  title: z.string().trim().min(1).optional(),
  workspaceRoot: z.string().trim().min(1).optional(),
  icon: ProjectIcon.nullable().optional(),
  t3ProjectId: z.string().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z.object({
  title: z.string().trim().min(1).optional(),
  workspaceRoot: z.string().trim().min(1).nullable().optional(),
  icon: ProjectIcon.nullable().optional(),
  collapsed: z.boolean().optional(),
  archived: z.boolean().optional(),
  reviewSkill: ReviewSkillRef.nullable().optional(),
  planSkill: PlanSkillRef.nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const LinkInput = z.object({
  /** URL, Jira key (ABC-123), GitHub PR URL, t3code:// thread link or T3 thread id. Kind is inferred when omitted. */
  value: z.string().trim().min(1).optional(),
  kind: LinkKind.optional(),
  label: z.string().optional(),
  t3Thread: T3ThreadRef.optional(),
  /** A Claude Code or Copilot CLI session, so the board can show its status and resume it in a terminal. */
  agentSession: AgentSessionRef.optional(),
});
export type LinkInput = z.infer<typeof LinkInput>;

/** What adding a link returns: the link, plus a warning when it was accepted with something unverified. */
export type AddLinkResult = TaskLink & { warning?: string };

export const CreateTaskInput = z
  .object({
    projectId: z.string(),
    /** Required unless `sourceUrl` is given, which supplies a placeholder title until the import fills it in. */
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    plan: PlanInput.optional(),
    /** "epic" makes an epic, which takes no plan. Defaults to "task". */
    kind: TaskKind.optional(),
    /** The epic to put the task in (uuid, "#42" or "42"); it must be in the same project. */
    epicId: z.string().trim().min(1).optional(),
    links: z.array(LinkInput).optional(),
    /** Normalised by the server; see normalizeLabels. */
    labels: z.array(z.string()).optional(),
    /** The Autopilot flag: null or omitted is Default. */
    autopilot: z.boolean().nullable().optional(),
    /** The auto-merge flag: null or omitted is Default (off). */
    autoMerge: z.boolean().nullable().optional(),
    /** True puts the task in the priority lane. Defaults to false. */
    priority: z.boolean().optional(),
    /** Tasks that block this one (uuid, "#42" or "42"). */
    blockedBy: z.array(z.string().trim().min(1)).optional(),
    /**
     * A Jira key or URL, or a GitHub issue URL. The task is created at once with the issue as its title and link,
     * and a background job fills in the title, description and labels. Can't be combined with a plan.
     */
    sourceUrl: z.string().trim().min(1).optional(),
    /**
     * A template (id or name) to start from. Its title pattern, description, labels and plan fill in whatever the
     * other fields leave out; fields given here win. See templates.ts.
     */
    template: z.string().trim().min(1).optional(),
    /**
     * Where the task lands. Defaults to "planned" when a plan is given and to "backlog" otherwise, so a template's
     * plan is copied into a Backlog task unless "planned" is asked for.
     */
    status: z.enum(["backlog", "planned"]).optional(),
    actor: z.string().optional(),
  })
  .refine((input) => input.title !== undefined || input.sourceUrl !== undefined || input.template !== undefined, {
    message: "Provide a title, a sourceUrl or a template",
    path: ["title"],
  })
  .refine((input) => input.sourceUrl === undefined || input.plan === undefined, {
    message: "A task imported from an issue can't be created with a plan",
    path: ["plan"],
  });

export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  planContext: z.string().nullable().optional(),
  projectId: z.string().optional(),
  archived: z.boolean().optional(),
  /** null inherits the global auto-review setting. */
  autoReview: z.boolean().nullable().optional(),
  /** null is Default: Start planned tasks never starts the task. */
  autopilot: z.boolean().nullable().optional(),
  /** null is Default: merge_task_pr refuses to merge the task's PR, as for false. */
  autoMerge: z.boolean().nullable().optional(),
  /** True puts the task in the priority lane above every project; false takes it out. */
  priority: z.boolean().optional(),
  /** Replaces the whole label list. */
  labels: z.array(z.string()).optional(),
  /** null clears it. */
  suggestedModel: SuggestedModelInput.nullable().optional(),
  /** The epic to put the task in (uuid, "#42" or "42"); null takes it out of its epic. */
  epicId: z.string().trim().min(1).nullable().optional(),
  /** Tasks to add as blockers of this one (uuid, "#42" or "42"). A cycle is rejected. */
  addBlockedBy: z.array(z.string().trim().min(1)).optional(),
  /** Blockers to remove. Removing a relation that doesn't exist does nothing. */
  removeBlockedBy: z.array(z.string().trim().min(1)).optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const SetDeliveryInput = z.object({ delivery: EpicDelivery });
export type SetDeliveryInput = z.infer<typeof SetDeliveryInput>;

export const MoveTaskInput = z.object({
  status: TaskStatusInput.optional(),
  /** Place before this task (same project+status). */
  beforeId: z.string().nullable().optional(),
  /** Place after this task (same project+status). */
  afterId: z.string().nullable().optional(),
});
export type MoveTaskInput = z.infer<typeof MoveTaskInput>;

export const CloseTaskInput = z
  .object({
    resolution: TaskResolution,
    /** The delivering / original task: uuid, "#42" or "42". Required unless the resolution is wont_do. */
    byTask: z.string().trim().min(1).optional(),
  })
  .refine((input) => resolutionNeedsTask(input.resolution) === (input.byTask !== undefined), {
    message: "completed and duplicate need byTask; wont_do must not have one",
    path: ["byTask"],
  });
export type CloseTaskInput = z.infer<typeof CloseTaskInput>;

export const StepPatch = z.object({
  title: z.string().trim().min(1).optional(),
  notes: z.string().nullable().optional(),
  /** When set, appended to existing notes on a new paragraph instead of replacing. */
  appendNotes: z.string().optional(),
  status: StepStatus.optional(),
});
export type StepPatch = z.infer<typeof StepPatch>;

export const AppSettings = z
  .object({
    jiraBaseUrl: z.string().nullable(),
    githubPolling: z.boolean(),
    /** Which T3 link the primary "Open in T3 Code" action uses. */
    t3LinkTarget: z.enum(["desktop", "browser"]),
    /** Whether a T3 orchestration:read token is stored (the token itself is never returned). */
    t3TokenSet: z.boolean(),
    /**
     * Let agents start T3 threads (start_task_thread) and message them (message_task_thread) over MCP. Off by
     * default: unlike the launch dialog, nobody sees the model or access before the agent starts.
     */
    agentT3Threads: z.boolean(),
    /** Moving a task to Review opens a local review round, unless the task overrides it. */
    autoReview: z.boolean(),
    /** The skill reviewers follow, unless the task's project overrides it. */
    reviewSkill: ReviewSkillRef,
    /** The skill bulk-planning sessions follow, unless the project overrides it. */
    planSkill: PlanSkillRef,
    reviewMaxRounds: z.number().int().min(1).max(10),
    /** Let the board run a headless reviewer when no agent picks a round up. */
    headlessReviewEnabled: z.boolean(),
    /** The Claude Code CLI to run; null looks up `claude` on PATH. New Claude Code sessions start it too. */
    headlessReviewCli: z.string().nullable(),
    /** The Copilot CLI new Copilot sessions start; null looks up `copilot` on PATH. */
    copilotCli: z.string().nullable(),
    headlessReviewBudgetUsd: z.number().positive().max(100),
    /** Fill in tasks created from a Jira or GitHub issue URL in the background. */
    issueImportEnabled: z.boolean(),
    /** The model `claude -p` runs for an import, as `--model` takes it (an alias like "haiku" or a full id). */
    issueImportModel: z.string(),
    issueImportBudgetUsd: z.number().positive().max(100),
    /**
     * The Jira tools an import may call, as Claude Code names them (`mcp__<server>__<tool>`; a `*` is allowed after
     * the server). Empty looks for the common read-only Jira tools on every configured MCP server.
     */
    issueImportJiraTools: z.array(z.string()),
    /** What each suggested model tier means: a description for prompts and an optional T3 Code model. */
    modelTiers: ModelTiers,
    /** Where "Open in terminal" resumes agent sessions. */
    terminal: TerminalSetting,
    /** Windows Terminal only: a tab in its last window, or a new window. */
    terminalOpenIn: TerminalOpenIn,
    /** Which notifications are recorded, and whether quiet hours silence their popups. */
    notifications: NotificationSettings,
    /** Named sets of board filters, in the order the user keeps them. */
    savedViews: SavedViews,
    /** The shortcuts the user changed; every other command keeps its default. */
    keybindings: KeybindingOverrides,
  })
  .extend(BackupSettings.shape);

export type AppSettings = z.infer<typeof AppSettings>;

export const UpdateSettingsInput = z.object({
  jiraBaseUrl: z.string().trim().nullable().optional(),
  githubPolling: z.boolean().optional(),
  t3LinkTarget: z.enum(["desktop", "browser"]).optional(),
  agentT3Threads: z.boolean().optional(),
  autoReview: z.boolean().optional(),
  reviewSkill: ReviewSkillRef.optional(),
  planSkill: PlanSkillRef.optional(),
  reviewMaxRounds: z.number().int().min(1).max(10).optional(),
  headlessReviewEnabled: z.boolean().optional(),
  headlessReviewCli: z.string().trim().nullable().optional(),
  copilotCli: z.string().trim().nullable().optional(),
  headlessReviewBudgetUsd: z.number().positive().max(100).optional(),
  issueImportEnabled: z.boolean().optional(),
  issueImportModel: z.string().trim().min(1).optional(),
  issueImportBudgetUsd: z.number().positive().max(100).optional(),
  issueImportJiraTools: z.array(z.string().trim().min(1)).optional(),
  /** Replaces the tiers given; tiers left out keep their setting. */
  modelTiers: ModelTiers.partial().optional(),
  terminal: TerminalSetting.optional(),
  terminalOpenIn: TerminalOpenIn.optional(),
  /** Merges into the notification settings: kinds left out keep their switch. */
  notifications: UpdateNotificationSettingsInput.optional(),
  /** Replaces the whole list of saved views. */
  savedViews: SavedViews.optional(),
  /** Replaces the overrides: a command left out goes back to its default. */
  keybindings: KeybindingOverrides.optional(),
  backupEnabled: z.boolean().optional(),
  backupDir: z.string().trim().nullable().optional(),
  backupRemote: z.string().trim().nullable().optional(),
  backupIntervalMinutes: BackupSettings.shape.backupIntervalMinutes.optional(),
  /** null clears the token. */
  t3Token: z.string().trim().nullable().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

/** A T3 pairing link or code (exchanged for a token by the server) or a raw bearer token. */
export const ConnectT3Input = z.object({ value: z.string().trim().min(1) });
export type ConnectT3Input = z.infer<typeof ConnectT3Input>;

export const GithubHostStatus = z.object({
  host: z.string(),
  login: z.string().nullable(),
  authenticated: z.boolean(),
});
export type GithubHostStatus = z.infer<typeof GithubHostStatus>;

export const GithubStatus = z.object({
  available: z.boolean(),
  /** Signed in to at least one host. */
  authenticated: z.boolean(),
  error: z.string().nullable(),
  /** Hosts `gh` holds a login for. Empty when `gh` is too old to report them. */
  hosts: z.array(GithubHostStatus),
});
export type GithubStatus = z.infer<typeof GithubStatus>;

export const IntegrationsStatus = z.object({ t3: T3IntegrationStatus, github: GithubStatus });
export type IntegrationsStatus = z.infer<typeof IntegrationsStatus>;

export const ConnectT3Result = z.object({
  settings: AppSettings,
  t3: T3IntegrationStatus,
  warning: z.string().optional(),
});
export type ConnectT3Result = z.infer<typeof ConnectT3Result>;

export const T3ProjectCandidate = z.object({
  t3ProjectId: z.string(),
  title: z.string(),
  workspaceRoot: z.string(),
  icon: ProjectIcon.nullable(),
  /** Already present on the board (matched by workspace key). */
  existingProjectId: z.string().nullable(),
});
export type T3ProjectCandidate = z.infer<typeof T3ProjectCandidate>;

export const FsBrowseResult = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  entries: z.array(z.object({ name: z.string(), fullPath: z.string() })),
});
export type FsBrowseResult = z.infer<typeof FsBrowseResult>;

export const ApiErrorCode = z.enum(["NOT_FOUND", "PLAN_REQUIRED", "VALIDATION", "CONFLICT", "INTERNAL"]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({ code: ApiErrorCode, message: z.string(), details: z.unknown().optional() }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** `GET /api/health`. `id` lets a client (the desktop shell) tell our server apart from whatever else holds the port. */
export const Health = z.object({ ok: z.literal(true), id: z.string(), version: z.string() });
export type Health = z.infer<typeof Health>;
