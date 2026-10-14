import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────

export const TaskStatus = z.enum(["idea", "planned", "in_progress", "review", "done"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TASK_STATUSES: ReadonlyArray<{ value: TaskStatus; label: string }> = [
  { value: "idea", label: "Ideas" },
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

export const StepStatus = z.enum(["todo", "in_progress", "done", "blocked", "skipped"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const LinkKind = z.enum(["pr", "jira", "t3_thread", "url"]);
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

export const PrSnapshot = z.object({
  state: z.enum(["open", "draft", "merged", "closed"]),
  title: z.string(),
  checks: z.enum(["passing", "failing", "pending", "none"]),
  reviewDecision: z.enum(["approved", "changes_requested", "review_required"]).nullable(),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  headRef: z.string().nullable(),
  updatedAt: IsoDate.nullable(),
});
export type PrSnapshot = z.infer<typeof PrSnapshot>;

export const T3ThreadRef = z.object({
  environmentId: z.string().min(1),
  threadId: z.string().min(1),
});
export type T3ThreadRef = z.infer<typeof T3ThreadRef>;

export const T3ThreadStatus = z.enum(["working", "waiting", "input", "approval", "failed", "done", "idle"]);
export type T3ThreadStatus = z.infer<typeof T3ThreadStatus>;

export const T3ThreadSnapshot = z.object({ title: z.string(), status: T3ThreadStatus });
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
  ]),
  severity: z.enum(["warning", "error"]),
  message: z.string(),
});
export type AttentionReason = z.infer<typeof AttentionReason>;

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

/** Compact pointer to another task, e.g. the one that resolved this one. */
export const TaskRef = z.object({ id: z.string(), number: z.number().int(), title: z.string() });
export type TaskRef = z.infer<typeof TaskRef>;

export const TaskSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  projectId: z.string(),
  title: z.string(),
  status: TaskStatus,
  position: z.string(),
  archivedAt: IsoDate.nullable(),
  createdBy: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  statusChangedAt: IsoDate,
  resolution: TaskResolution.nullable(),
  /** The task that delivered or duplicates this one; null for "won't do" or once that task is deleted. */
  resolvedBy: TaskRef.nullable(),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  /** Per-step statuses in plan order, for segmented progress bars. */
  stepStatuses: z.array(StepStatus),
  currentStep: CurrentStep.nullable(),
  links: z.array(TaskLink),
  attention: z.array(AttentionReason),
  lastNote: z.object({ text: z.string(), actor: z.string(), at: IsoDate }).nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const TaskDetail = TaskSummary.extend({
  description: z.string().nullable(),
  planContext: z.string().nullable(),
  phases: z.array(PlanPhase),
  events: z.array(TaskEvent),
  /** Tasks closed as done by, or duplicates of, this one. */
  resolves: z.array(TaskRef.extend({ resolution: TaskResolution })),
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
  integrations: z.object({ t3: T3IntegrationStatus }),
});
export type BoardSnapshot = z.infer<typeof BoardSnapshot>;

export const BoardEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.upserted"), project: Project }),
  z.object({ type: z.literal("project.deleted"), projectId: z.string() }),
  z.object({ type: z.literal("task.upserted"), task: TaskSummary }),
  z.object({ type: z.literal("task.deleted"), taskId: z.string() }),
  z.object({ type: z.literal("task.detail_changed"), taskId: z.string() }),
  z.object({ type: z.literal("integrations.changed"), t3: T3IntegrationStatus }),
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
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

export const LinkInput = z.object({
  /** URL, Jira key (ABC-123), GitHub PR URL, or t3code:// thread link. Kind is inferred when omitted. */
  value: z.string().trim().min(1).optional(),
  kind: LinkKind.optional(),
  label: z.string().optional(),
  t3Thread: T3ThreadRef.optional(),
});
export type LinkInput = z.infer<typeof LinkInput>;

export const CreateTaskInput = z.object({
  projectId: z.string(),
  title: z.string().trim().min(1),
  description: z.string().optional(),
  plan: PlanInput.optional(),
  links: z.array(LinkInput).optional(),
  actor: z.string().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  planContext: z.string().nullable().optional(),
  projectId: z.string().optional(),
  archived: z.boolean().optional(),
});
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const MoveTaskInput = z.object({
  status: TaskStatus.optional(),
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

export const AppSettings = z.object({
  jiraBaseUrl: z.string().nullable(),
  githubPolling: z.boolean(),
  /** Which T3 link the primary "Open in T3 Code" action uses. */
  t3LinkTarget: z.enum(["desktop", "browser"]),
  /** Whether a T3 orchestration:read token is stored (the token itself is never returned). */
  t3TokenSet: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const UpdateSettingsInput = z.object({
  jiraBaseUrl: z.string().trim().nullable().optional(),
  githubPolling: z.boolean().optional(),
  t3LinkTarget: z.enum(["desktop", "browser"]).optional(),
  /** null clears the token. */
  t3Token: z.string().trim().nullable().optional(),
});
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

export const GithubStatus = z.object({
  available: z.boolean(),
  authenticated: z.boolean(),
  error: z.string().nullable(),
});
export type GithubStatus = z.infer<typeof GithubStatus>;

export const IntegrationsStatus = z.object({ t3: T3IntegrationStatus, github: GithubStatus });
export type IntegrationsStatus = z.infer<typeof IntegrationsStatus>;

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
