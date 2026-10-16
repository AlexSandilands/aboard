import type {
  AppSettings,
  BoardSnapshot,
  CreateProjectInput,
  CreateTaskInput,
  CreateTemplateInput,
  IssueSnapshot,
  LinkInput,
  MoveTaskInput,
  PlanInput,
  PlanPhase,
  PlanStep,
  PlanStepInput,
  Project,
  PrSnapshot,
  ResolveFindingInput,
  ReviewFinding,
  ReviewRoundStatus,
  ReviewSkillRef,
  ReviewTrigger,
  StepPatch,
  StepStatus,
  SubmitReviewInput,
  T3ThreadSnapshot,
  TaskDetail,
  LabelUsage,
  TaskEvent,
  TaskLink,
  TaskResolution,
  TaskReview,
  TaskStatus,
  TaskSummary,
  TaskTemplate,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
  UpdateTemplateInput,
} from "@repo/contracts";
import type { ImportRecord } from "../db/repos/imports.ts";
import type { ReviewRecord } from "../db/repos/reviews.ts";
import type { AutopilotService } from "./autopilot.ts";
import type { BackupService } from "./backup/index.ts";
import type { RecurringService } from "./recurring.ts";
import type { Effects } from "./core.ts";

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
  reviews: ReviewsService;
  labels: LabelsService;
  imports: ImportsService;
  backup: BackupService;
  templates: TemplatesService;
  autopilot: AutopilotService;
  recurring: RecurringService;
}

export interface ProjectRef {
  projectId?: string;
  /** Absolute workspace path; matched by normalized workspace key. */
  workspacePath?: string;
}

export interface ProjectsService {
  list(opts?: { includeArchived?: boolean }): Project[];
  get(id: string): Project;
  /**
   * Finds a project by id or workspace path. With autoCreate, an unknown path creates a project (title = folder
   * name) and a match on an archived project unarchives it.
   */
  resolve(ref: ProjectRef, opts?: { autoCreate?: boolean }): Project;
  /**
   * Throws CONFLICT if an active project with the same workspace key exists; an archived one is unarchived and
   * returned instead. Appends to the end of the lane order.
   */
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
  /** Matches title, description, "#number", Jira keys and labels, case-insensitively. */
  query?: string;
  /** Tasks carrying any of these labels (normalised before matching). */
  labels?: string[];
  attentionOnly?: boolean;
  /** Children of this epic (an id). */
  epicId?: string;
}

export interface TasksService {
  summaries(query?: TaskQuery): TaskSummary[];
  summary(id: string): TaskSummary;
  detail(id: string): TaskDetail;
  /** Accepts a uuid, "#42" or "42". */
  resolveId(ref: string): string;
  /**
   * Lands in "planned" when `plan` is given (with ≥1 step), else "backlog". Appends to the end of the column.
   * With `sourceUrl` (a Jira key or URL, or a GitHub issue URL) the task is titled and linked after the issue and
   * an import is left pending; throws VALIDATION when the source isn't recognised. The caller starts the import.
   */
  create(input: CreateTaskInput): TaskDetail;
  /** Creates an epic and puts the given tasks in it, all or nothing. */
  createEpic(input: Omit<CreateTaskInput, "kind" | "epicId" | "plan">, taskIds: string[], actor: string): TaskDetail;
  update(id: string, input: UpdateTaskInput, actor: string): TaskDetail;
  /**
   * Status change and/or reorder. Throws PLAN_REQUIRED when leaving "backlog" without plan steps.
   * Moving a closed task out of Done clears its resolution. `because` adds fields to the status_changed event
   * payload, for automatic moves that should say why (e.g. `{ mergedPr: "owner/repo#12" }`); it cannot override
   * from/to/clearedResolution.
   * Entering Review from any status but Done, with all its PRs finished and one merged, is followed by a second
   * move to Done by actor "github" (see LinksService.setSnapshot); the returned summary is then in Done.
   */
  move(id: string, input: MoveTaskInput, actor: string, because?: Record<string, unknown>): TaskSummary;
  /**
   * Closes the task with a resolution and moves it to Done, without the plan check `move` applies.
   * completed/duplicate need `byTaskId` (an existing other task); wont_do must not have one.
   */
  close(id: string, input: CloseInput, actor: string): TaskDetail;
  addNote(id: string, text: string, actor: string): TaskEvent;
  /**
   * Permanently deletes an archived task with its activity, plan and links. Throws VALIDATION if it isn't
   * archived. Tasks closed against it keep their resolution but lose the pointer.
   */
  delete(id: string, actor: string): void;
}

export interface CloseInput {
  resolution: TaskResolution;
  byTaskId?: string;
}

/** A step that replacing the plan would delete. `label` is its "phase.step" position before the call. */
export interface PlanDeletion {
  label: string;
  title: string;
  status: StepStatus;
  hasNotes: boolean;
  /** Every step of its phase is deleted too. */
  phaseDropped: boolean;
}

/** In-place edits to a plan. Refs (`2.3` labels, step/phase ids, phase numbers) resolve against the plan before any edit. */
export interface PlanUpdateInput {
  steps?: Array<
    StepPatch & {
      step: string;
      /** Where the step goes: a phase (number or id, appended) and/or next to another step (`before`/`after`, a step ref). */
      move?: { phase?: string; before?: string; after?: string };
    }
  >;
  phases?: Array<{ phase: string; title: string }>;
}

export interface PlansService {
  /**
   * Replaces the plan. Phases/steps given with an existing `id` are kept (status and
   * timestamps preserved unless overridden); others are created; missing ones are deleted.
   * Throws PLAN_REQUIRED if the result has no steps and the task is not in Backlog.
   * With `protectStarted`, throws CONFLICT instead of deleting a step that isn't `todo` or has notes, or all of a
   * phase's steps while other existing steps are kept (a partial update, not a rewrite).
   */
  setPlan(taskId: string, plan: PlanInput, actor: string, opts?: { protectStarted?: boolean }): TaskDetail;
  /** The steps `setPlan` would delete for this input, in plan order. Writes nothing. */
  deletionsOf(taskId: string, plan: PlanInput): PlanDeletion[];
  /**
   * Patches steps and renames phases in place, nothing else changes. All-or-nothing: one bad ref or
   * move changes nothing. One activity entry per change, as the single edits log.
   */
  updatePlan(taskId: string, input: PlanUpdateInput, actor: string): TaskDetail;
  addPhase(taskId: string, title: string, actor: string, opts?: { afterPhaseId?: string }): PlanPhase;
  updatePhase(phaseId: string, patch: { title: string }, actor: string): PlanPhase;
  deletePhase(phaseId: string, actor: string): void;
  addSteps(phaseId: string, steps: PlanStepInput[], actor: string, opts?: { afterStepId?: string }): PlanStep[];
  /** Sets started_at on first in_progress, completed_at on done/skipped (cleared when reopened). */
  updateStep(stepId: string, patch: StepPatch, actor: string): PlanStep;
  moveStep(
    stepId: string,
    to: { phaseId?: string; beforeId?: string | null; afterId?: string | null },
    actor: string,
  ): PlanStep;
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
  /** How many T3 threads were ever linked to a task, unlinked ones included. Only ever grows. */
  threadsLinked(taskId: string): number;
  /**
   * Stores a poller snapshot. Publishes task.upserted only when the snapshot changed. A PR that just became merged
   * or closed moves its task from Review to Done (actor "github") once all its PRs are finished and one merged.
   * Because only that transition triggers it:
   * - a link with no snapshot yet whose first successful poll sees "merged" counts as the merge, so after polling
   *   was off or gh was unauthenticated for a while, several Review tasks can move to Done at once;
   * - a merge seen while the task was not in Review (e.g. still In Progress) is used up here; `TasksService.move`
   *   completes the task instead when it later enters Review.
   */
  setSnapshot(linkId: string, snapshot: PrSnapshot | T3ThreadSnapshot | IssueSnapshot | null): void;
}

export interface SettingsService {
  get(): AppSettings;
  update(input: UpdateSettingsInput): AppSettings;
  /** The stored T3 token (server-side only). */
  t3Token(): string | null;
}

export interface OpenRoundOptions {
  trigger: ReviewTrigger;
  actor: string;
  /** Open a manual round even past the round limit (the user's explicit request). */
  force?: boolean;
}

export interface ReviewsService {
  /** Rounds oldest first, with findings. */
  list(taskId: string): TaskReview[];
  /** The task's override, else the global setting. */
  effectiveAutoReview(taskId: string): boolean;
  /** The project's override, else the global setting. */
  skillFor(taskId: string): ReviewSkillRef;
  /**
   * Opens the next round as pending. An unfinished latest round is reused: a pending one is returned as is
   * (a move onto a manual round starts a new cycle), a stalled or failed one goes back to pending. A move
   * starts a new cycle; manual rounds past the cycle's limit throw VALIDATION unless forced. Throws CONFLICT
   * while a round is running.
   */
  openRound(taskId: string, opts: OpenRoundOptions): TaskReview;
  /** openRound inside an existing write (for tasks.move). */
  openRoundIn(taskId: string, opts: OpenRoundOptions, fx: Effects): ReviewRecord;
  /**
   * Records findings on a round (default: the latest unsubmitted one, opening one if none is). Throws CONFLICT
   * when that round was already submitted.
   */
  submit(taskId: string, input: SubmitReviewInput, actor: string): TaskReview;
  /** Accepts a finding id or a "R2.3" label. wont_fix needs a note; "open" reopens. */
  resolveFinding(taskId: string, ref: string, input: ResolveFindingInput, actor: string): ReviewFinding;
  /** Rounds in a status on non-archived tasks, oldest first (for the board's fallbacks). */
  roundsWithStatus(status: ReviewRoundStatus): ReviewRecord[];
  /** Records that the board asked the task's T3 thread to run the round. False when it's no longer pending. */
  markNudged(reviewId: string, actor: string): boolean;
  /**
   * For the board's own fallbacks: running, stalled, failed or back to pending. With `from`, only applies when
   * the round is still in one of those statuses (checked in the same transaction) and returns null otherwise.
   */
  setRoundStatus(
    reviewId: string,
    status: Exclude<ReviewRoundStatus, "submitted">,
    opts: { actor: string; error?: string; from?: ReadonlyArray<ReviewRoundStatus> },
  ): TaskReview | null;
}

export interface LabelsService {
  /** Labels on active tasks, by name, with counts and colour overrides. */
  usage(): LabelUsage[];
  /** Colour overrides by label. */
  colors(): Record<string, number>;
  /** Sets a label's colour override (the label need not be in use); returns all overrides. */
  setColor(label: string, hue: number): Record<string, number>;
  /** Drops the override so the label takes its hashed hue again; returns all overrides. */
  clearColor(label: string): Record<string, number>;
}

/** What an import found out about an issue. */
export interface ImportResult {
  title: string;
  description: string | null;
  /** Raw label suggestions; normalised, deduped and capped when applied. */
  labels: string[];
}

/** The background fill-in of tasks created from a Jira or GitHub issue (see CreateTaskInput.sourceUrl). */
export interface ImportsService {
  get(taskId: string): ImportRecord | null;
  /** Pending imports on non-archived tasks, oldest first. */
  pending(): ImportRecord[];
  /** Counts a run against the import. Null when it is no longer pending (finished, or its task is gone). */
  claim(taskId: string): ImportRecord | null;
  /**
   * Applies the result and marks the import done. The title is replaced only while it is still the placeholder and
   * the description only while empty, so edits made during the fetch stand; labels are added to the task's.
   */
  complete(taskId: string, result: ImportResult): void;
  /** Marks the import failed with the reason; the card shows it as a warning. */
  fail(taskId: string, error: string): void;
  /**
   * Puts a failed (or stuck pending) import back to pending with a fresh attempt count. Throws CONFLICT when it is
   * done. Starting it again is the caller's job; one already running ignores that.
   */
  retry(taskId: string, actor: string): void;
}

export interface TemplatesService {
  /** Board-wide templates and every project's; with `projectId`, those board-wide and that project's. */
  list(opts?: { projectId?: string }): TaskTemplate[];
  get(id: string): TaskTemplate;
  /**
   * The template `ref` (an id or a name, any case) names for a task in `projectId`: the project's own wins over a
   * board-wide one of the same name. Throws NOT_FOUND, listing what is available.
   */
  resolve(ref: string, projectId: string): TaskTemplate;
  /** Throws CONFLICT when the scope already has a template of that name. Phases without steps are dropped. */
  create(input: CreateTemplateInput): TaskTemplate;
  update(id: string, input: UpdateTemplateInput): TaskTemplate;
  /** A copy named "<name> copy" in the same scope. */
  duplicate(id: string): TaskTemplate;
  /** Tasks made from it keep what they copied and forget which template it was. */
  delete(id: string): void;
}

export interface BoardService {
  snapshot(): BoardSnapshot;
}
