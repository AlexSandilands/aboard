import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PlanInput, parsePlanMarkdown, type Project } from "@repo/contracts";
import { renderTaskShort } from "./format.ts";
import type { AppContext } from "../app.ts";
import { AppError } from "../errors.ts";
import type { Services } from "../services/types.ts";

/** What every tool module gets: the service layer plus actor resolution for this request. */
export interface ToolContext {
  services: Services;
  ctx: AppContext;
  /** Explicit `actor` arg wins, then the MCP client name, then "agent". */
  actor: (explicit?: string) => string;
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

export const actorField = z
  .string()
  .optional()
  .describe("Who is acting, shown in the activity log. Defaults to your MCP client name.");

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

export function safeProject(services: Services, id: string): Project | undefined {
  try {
    return services.projects.get(id);
  } catch {
    return undefined;
  }
}

/** Mutating tools answer with a one-line confirmation plus the task's new state. */
export function taskResult(services: Services, taskId: string, headline: string): CallToolResult {
  const task = services.tasks.detail(taskId);
  return textResult(`${headline}\n\n${renderTaskShort(task, safeProject(services, task.projectId))}`);
}

/** set_plan / create_task accept a structured plan or markdown; returns null when neither was given. */
export function planFromArgs(args: {
  phases?: PlanInput["phases"] | undefined;
  markdown?: string | undefined;
  context?: string | undefined;
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
  return { ...plan, ...(context !== undefined ? { context } : {}) };
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
};
