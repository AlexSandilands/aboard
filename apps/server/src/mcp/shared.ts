import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AUTOPILOT_START_PLANNED,
  deliveryHintApplies,
  MODEL_TIERS,
  ModelTier,
  PlanInput,
  parsePlanMarkdown,
  SUGGESTED_MODEL_REASON_MAX,
  type Project,
  type TaskDetail,
  type TaskEvent,
} from "@repo/contracts";
import { deliveryHint, renderTaskShort, type ChildActivity } from "./format.ts";
import type { AppContext } from "../app.ts";
import { boardUrlOf } from "../config.ts";
import { AppError } from "../errors.ts";
import type { Services } from "../services/types.ts";

/** What every tool module gets: the service layer plus actor resolution for this request. */
export interface ToolContext {
  services: Services;
  ctx: AppContext;
  /** Explicit `actor` arg wins, then the MCP client name, then "agent". */
  actor: (explicit?: string) => string;
  /** The MCP client's name (from initialize, else the User-Agent), to tailor hints to the harness. */
  client: () => string | undefined;
}

export type ToolRegistrar = (server: McpServer, tc: ToolContext) => void;

// ── Shared input fields ──────────────────────────────────────────────────

export const projectFields = {
  projectId: z.string().optional().describe("Project id. Usually omit and pass workspacePath instead."),
  workspacePath: z
    .string()
    .optional()
    .describe("Absolute path of the repo/workspace you are working in (your cwd). Identifies the project."),
};

export const taskField = z.string().min(1).describe('Task reference: "#42", "42", or the task uuid.');

export const epicField = z
  .string()
  .min(1)
  .describe('The epic this task belongs to: "#12", "12" or its uuid. It must be in the same project.');

export const templateField = z
  .string()
  .min(1)
  .describe(
    "Start from a template: its name or id (list_templates shows them). Its title pattern, description, labels and " +
      "plan fill in whatever you leave out, and anything you pass wins; labels you pass replace the template's.",
  );

export const blockedByField = z
  .array(z.string().min(1))
  .describe(
    'Tasks that must be Done before this one is ready: "#42", "42" or uuids. They may be in other ' +
      "projects; a relation that would make a cycle is refused.",
  );

export const actorField = z
  .string()
  .optional()
  .describe("Who is acting, shown in the activity log. Defaults to your MCP client name.");

export const labelsField = z
  .array(z.string().min(1))
  .describe(
    'Short type labels such as "ui", "backend", "server", "docs", "bug" or "tech-debt". Lowercased and deduped; ' +
      "reuse labels already on the board (board_overview lists them) rather than inventing near-duplicates.",
  );

export const suggestedModelField = z
  .object({
    tier: ModelTier.describe(MODEL_TIERS.map((t) => `${t.value}: ${t.description}`).join(" ")),
    reason: z
      .string()
      .max(SUGGESTED_MODEL_REASON_MAX)
      .optional()
      .describe("One short sentence on why, e.g. 'Mechanical rename across 3 files'."),
  })
  .describe(
    "The model tier you suggest for implementing this task, judged by its complexity and risk. The user maps each " +
      "tier to a model, so the session that picks the task up starts on (or is reminded to switch to) that model.",
  );

export const autopilotField = z
  .enum(["default", "on", "off"])
  .describe(
    "Whether Autopilot may start this task by itself once it is planned. on: flag it. default and off: it is never " +
      "started automatically. Set it only when the user has said so; ask first, never on your own. You can't change " +
      "Autopilot's own settings.",
  );

export const priorityField = z
  .boolean()
  .describe(
    "True marks the task as priority: it shows in a lane above every project on the board, and Autopilot starts it " +
      "before other planned tasks. False takes it out. Set it only when the user has asked for it; never on your own.",
  );

export const deliveryField = z
  .enum(["main", "integration"])
  .describe(
    "How the epic's tasks are delivered. main: each task opens a pull request to the default branch and the user " +
      "merges it. integration: the board makes the branch epic/<number>-<slug> on origin; the tasks start from it " +
      "and open their pull requests against it, Autopilot merges each one there once it is reviewed and green, and " +
      "the user merges the epic's own pull request into the default branch. Set it only after the user has chosen; " +
      "ask first, never on your own. Back to main only while none of the epic's tasks has started.",
  );

/** The task's stored flag (null is Default) for a tool's `autopilot` argument. */
export const autopilotValue = (choice: z.infer<typeof autopilotField>): boolean | null =>
  choice === "default" ? null : choice === "on";

export const t3ThreadField = z
  .object({
    environmentId: z.string().min(1).describe("From the T3 tool t3_environment_read."),
    threadId: z.string().min(1).describe("From the T3 tool t3_thread_configuration."),
  })
  .describe("The T3 Code thread doing this work, so the user can jump back to it from the board.");

export const planPhasesField = z
  .array(
    z.object({
      id: z.string().optional().describe("Existing phase id (from get_task) to keep it."),
      title: z.string().min(1),
      steps: z.array(
        z.object({
          id: z.string().optional().describe("Existing step id (from get_task) to keep its status/notes."),
          title: z.string().min(1).describe("Concrete, verifiable action, e.g. 'Add migration for links table'."),
          notes: z.string().optional(),
          status: z.enum(["todo", "in_progress", "done", "blocked", "skipped"]).optional(),
        }),
      ),
    }),
  )
  .describe("Ordered phases, each with 3-8 concrete, verifiable steps.");

// ── Results ──────────────────────────────────────────────────────────────

/**
 * Text only, on purpose: some clients (Claude Code) show `structuredContent` instead of the text when both are
 * present, which hid task titles, plans and activity from agents. Everything an agent needs goes in the text.
 */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Runs a tool body, mapping AppError to "CODE: message" and hiding anything else's internals. */
export async function run(
  body: () => CallToolResult | Promise<CallToolResult>,
  hints?: Partial<Record<AppError["code"], string>>,
): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof AppError) {
      const hint = hints?.[error.code];
      return errorResult(`${error.code}: ${error.message}${hint ? `\n${hint}` : ""}`);
    }
    if (error instanceof z.ZodError) {
      return errorResult(
        `VALIDATION: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
      );
    }
    console.error("[mcp] tool failed", error);
    return errorResult(`INTERNAL: ${error instanceof Error ? error.message : "unexpected error"}`);
  }
}

// ── Resolution helpers ───────────────────────────────────────────────────

export interface ProjectRefArgs {
  projectId?: string | undefined;
  workspacePath?: string | undefined;
}

export function hasProjectRef(args: ProjectRefArgs): boolean {
  return Boolean(args.projectId || args.workspacePath);
}

export function projectRef(args: ProjectRefArgs): { projectId?: string; workspacePath?: string } {
  return {
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.workspacePath ? { workspacePath: args.workspacePath } : {}),
  };
}

export function requireProjectRef(args: ProjectRefArgs): void {
  if (!hasProjectRef(args)) {
    throw new AppError("VALIDATION", "Pass workspacePath (your cwd) or projectId to identify the project.");
  }
}

/** Read-only lookup: an unknown project is "no tasks yet", not an error. */
export function findProject(services: Services, args: ProjectRefArgs) {
  try {
    return services.projects.resolve(projectRef(args), { autoCreate: false });
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** Each child's newest activity entry, for an epic's overview. */
export function childActivity(services: Services, epic: TaskDetail): ChildActivity {
  const activity = new Map<string, TaskEvent>();
  for (const child of epic.children) {
    const newest = services.tasks
      .detail(child.id)
      .events.reduce<TaskEvent | null>((latest, e) => (!latest || e.id > latest.id ? e : latest), null);
    if (newest) activity.set(child.id, newest);
  }
  return activity;
}

/** Where the user opens the board: this server when it serves the built web app, else the Vite dev server. */
export function boardUrl(ctx: AppContext): string {
  return boardUrlOf(ctx.config);
}

/**
 * Why an agent can't start T3 threads for a project's tasks, or null when it may: the board's canStartT3Thread,
 * plus the user's opt-in, since nobody sees the model or access before the agent starts.
 */
export function t3LaunchBlocker(ctx: AppContext, project: Project): string | null {
  if (!ctx.integrations.t3Status().detected) return "T3 Code isn't running";
  const settings = ctx.services.settings.get();
  if (!settings.t3TokenSet) return "No T3 Code token is set (Settings, Integrations, T3 Code)";
  if (!settings.agentT3Threads) {
    return "The user hasn't let agents start T3 threads (Settings, Integrations, T3 Code, Let agents start threads)";
  }
  if (!project.t3ProjectId && !project.workspaceRoot) return `${project.title} has no folder for T3 Code to use`;
  return null;
}

export function safeProject(services: Services, id: string): Project | undefined {
  try {
    return services.projects.get(id);
  } catch {
    return undefined;
  }
}

/** Whether Start planned tasks is on for a task, from the board, its project or its epic. False while it isn't registered. */
function startPlannedOn(services: Services, projectId: string, epicId: string | null): boolean {
  const automation = services.autopilot.automations().find((a) => a.key === AUTOPILOT_START_PLANNED);
  return automation !== undefined && services.autopilot.resolve(automation, projectId, epicId).enabled;
}

/**
 * The question to put to the user about an epic's delivery (deliveryHint), when deliveryHintApplies to it: nobody chose
 * one yet and its tasks look like they build on each other. Null otherwise, and for a task with no epic.
 */
export function epicDeliveryHint(services: Services, epicId: string | null): string | null {
  if (!epicId) return null;
  const epic = services.tasks.summary(epicId);
  if (epic.kind !== "epic") return null;
  const children = services.tasks.summaries({ projectId: epic.projectId }).filter((t) => t.parent?.id === epic.id);
  return deliveryHintApplies(epic, children) ? deliveryHint(epic) : null;
}

/**
 * Mutating tools answer with a one-line confirmation plus the task's new state. `planningHints` adds the
 * "Missing labels", "Suggested model" and (when Start planned tasks is on) "Autopilot flag" nudges; only the planning
 * moments (set_plan, create_task) ask for them, so they aren't noise elsewhere. Every result carries the "Plan progress"
 * nudges; `closing` (the move to Done) adds the open-steps one, which get_task never shows for a task that is already
 * Done.
 */
export function taskResult(
  services: Services,
  taskId: string,
  headline: string,
  opts: { planningHints?: boolean; closing?: boolean; deliveryHint?: boolean } = {},
): CallToolResult {
  const task = services.tasks.detail(taskId);
  const project = safeProject(services, task.projectId);
  const progress = { now: Date.now(), ...(opts.closing ? { closing: true } : {}) };
  // Planning one of an epic's tasks is when its shape shows, so set_plan and create_task ask about the epic too.
  const delivery =
    opts.deliveryHint || opts.planningHints
      ? epicDeliveryHint(services, task.kind === "epic" ? task.id : (task.parent?.id ?? null))
      : null;
  const body = opts.planningHints
    ? renderTaskShort(task, project, {
        labelsInUse: services.labels.usage(),
        modelHint: true,
        autopilotHint: startPlannedOn(services, task.projectId, task.parent?.id ?? null),
        deliveryHint: delivery,
        progress,
      })
    : renderTaskShort(task, project, { progress, deliveryHint: delivery });
  return textResult(`${headline}\n\n${body}`);
}

/** set_plan / create_task accept a structured plan or markdown; returns null when neither was given. */
export function planFromArgs(args: {
  phases?: PlanInput["phases"] | undefined;
  markdown?: string | undefined;
  context?: string | undefined;
  suggestedModel?: PlanInput["suggestedModel"];
}): PlanInput | null {
  if (args.phases && args.markdown) {
    throw new AppError("VALIDATION", "Pass either phases or markdown, not both.");
  }
  let plan: PlanInput | null = null;
  if (args.phases) {
    plan = PlanInput.parse({ phases: args.phases });
  } else if (args.markdown) {
    plan = parsePlanMarkdown(args.markdown);
    if (!plan) {
      throw new AppError(
        "VALIDATION",
        "No steps found in the markdown plan. Use '## Phase title' headings with '- [ ] step' list items under them.",
      );
    }
  }
  if (!plan) return null;
  const context = args.context ?? plan.context;
  return {
    ...plan,
    ...(context !== undefined ? { context } : {}),
    ...(args.suggestedModel !== undefined ? { suggestedModel: args.suggestedModel } : {}),
  };
}

export const planInputFields = {
  phases: planPhasesField.optional(),
  markdown: z
    .string()
    .optional()
    .describe(
      "Alternative to phases: a markdown plan. '## Heading' = phase, '- [ ] item' = step ([x] done, [~] in progress, [!] blocked, [-] skipped); nested lines become step notes.",
    ),
  context: z.string().optional().describe("Markdown: approach, key decisions, constraints. Shown above the plan."),
  suggestedModel: suggestedModelField.optional(),
};
