import type {
  AppSettings,
  BoardSnapshot,
  CreateProjectInput,
  CreateTaskInput,
  LinkInput,
  MoveTaskInput,
  PlanInput,
  PlanPhase,
  PlanStep,
  PlanStepInput,
  Project,
  PrSnapshot,
  StepPatch,
  T3ThreadSnapshot,
  TaskDetail,
  TaskEvent,
  TaskLink,
  TaskStatus,
  TaskSummary,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
} from "@taskboard/contracts";

/**
 * The service layer. REST routes, MCP tools and pollers all go through these — never
 * the database directly. Every mutation runs in a transaction, appends to task_events
 * where it concerns a task, and publishes BoardEvents on the bus after commit.
 *
 * `actor` is "user" for UI-originated changes, or an agent label (e.g. "claude-code").
 * Throws AppError (NOT_FOUND, PLAN_REQUIRED, VALIDATION, CONFLICT).
 */
export interface Services {
  projects: ProjectsService;
  tasks: TasksService;
  plans: PlansService;
  links: LinksService;
  settings: SettingsService;
  board: BoardService;
}

export interface ProjectRef {
  projectId?: string;
  /** Absolute workspace path; matched by normalized workspace key. */
  workspacePath?: string;
}

export interface ProjectsService {
  list(opts?: { includeArchived?: boolean }): Project[];
  get(id: string): Project;
  /** Finds a project by id or workspace path. With autoCreate, an unknown path creates a project (title = folder name). */
  resolve(ref: ProjectRef, opts?: { autoCreate?: boolean }): Project;
  /** Throws CONFLICT if a project with the same workspace key exists. Appends to the end of the lane order. */
  create(input: CreateProjectInput): Project;
  update(id: string, input: UpdateProjectInput): Project;
  /** Sets lane order to the given id order. */
  reorder(ids: string[]): void;
  /** Hard delete, cascading to tasks. */
  delete(id: string): void;
}

export interface TaskQuery {
  projectId?: string;
  status?: TaskStatus;
  includeArchived?: boolean;
  /** Matches title, description, "#number" and Jira keys, case-insensitively. */
  query?: string;
  attentionOnly?: boolean;
}

export interface TasksService {
  summaries(query?: TaskQuery): TaskSummary[];
  summary(id: string): TaskSummary;
  detail(id: string): TaskDetail;
  /** Accepts a uuid, "#42" or "42". */
  resolveId(ref: string): string;
  /** Lands in "planned" when `plan` is given (with ≥1 step), else "idea". Appends to the end of the column. */
  create(input: CreateTaskInput): TaskDetail;
  update(id: string, input: UpdateTaskInput, actor: string): TaskDetail;
  /** Status change and/or reorder. Throws PLAN_REQUIRED when leaving "idea" without plan steps. */
  move(id: string, input: MoveTaskInput, actor: string): TaskSummary;
  addNote(id: string, text: string, actor: string): TaskEvent;
}

export interface PlansService {
  /**
   * Replaces the plan. Phases/steps given with an existing `id` are kept (status and
   * timestamps preserved unless overridden); others are created; missing ones are deleted.
   * Throws PLAN_REQUIRED if the result has no steps and the task is not an idea.
   */
  setPlan(taskId: string, plan: PlanInput, actor: string): TaskDetail;
  addPhase(taskId: string, title: string, actor: string, opts?: { afterPhaseId?: string }): PlanPhase;
  updatePhase(phaseId: string, patch: { title: string }, actor: string): PlanPhase;
  deletePhase(phaseId: string, actor: string): void;
  addSteps(phaseId: string, steps: PlanStepInput[], actor: string, opts?: { afterStepId?: string }): PlanStep[];
  /** Sets started_at on first in_progress, completed_at on done/skipped (cleared when reopened). */
  updateStep(stepId: string, patch: StepPatch, actor: string): PlanStep;
  moveStep(stepId: string, to: { phaseId?: string; beforeId?: string | null; afterId?: string | null }, actor: string): PlanStep;
  deleteStep(stepId: string, actor: string): void;
  /** Accepts a step id or a 1-based "phase.step" label like "2.3". */
  resolveStepId(taskId: string, ref: string): string;
}

export interface LinksService {
  /** Idempotent on (task, kind, url). Infers kind via classifyLink when omitted. */
  add(taskId: string, input: LinkInput, actor: string): TaskLink;
  remove(linkId: string, actor: string): void;
  get(linkId: string): TaskLink;
  /** Links of a kind on non-archived tasks — for pollers. */
  listByKind(kind: TaskLink["kind"]): TaskLink[];
  /** Stores a poller snapshot. Publishes task.upserted only when the snapshot changed. */
  setSnapshot(linkId: string, snapshot: PrSnapshot | T3ThreadSnapshot | null): void;
}

export interface SettingsService {
  get(): AppSettings;
  update(input: UpdateSettingsInput): AppSettings;
  /** The stored T3 token (server-side only). */
  t3Token(): string | null;
}

export interface BoardService {
  snapshot(): BoardSnapshot;
}
