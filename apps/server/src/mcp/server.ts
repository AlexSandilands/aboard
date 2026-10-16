import type { Hono } from "hono";
import { BRAND } from "@repo/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppContext } from "../app.ts";
import type { ToolContext } from "./shared.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerTaskTools } from "./tools/tasks.ts";
import { registerPlanTools } from "./tools/plans.ts";
import { registerLinkTools } from "./tools/links.ts";
import { registerReviewTools } from "./tools/reviews.ts";

const INSTRUCTIONS = `${BRAND.name} is the user's local kanban board for tracking work across projects. Columns: Backlog -> Planned -> In Progress -> Review -> Done, one swimlane per project. Identify the project by passing workspacePath (your cwd).
- Orient with board_overview or list_tasks; ALWAYS call get_task before resuming an existing task.
- The backlog is cheap: add_to_backlog mid-task for anything worth doing later (an idea, a follow-up, a Jira ticket), then carry on.
- A task can't leave Backlog without a plan: set_plan (phases of 3-8 concrete, verifiable steps) before moving it to planned/in_progress. create_task makes a planned task in one call. When planning, also pass suggestedModel: the tier (light, standard or deep) the implementing session needs, judged by complexity and risk. If the result says the task has no labels, suggest 1-3 to the user (prefer labels already in use) and apply them with update_task once they agree.
- set_plan REPLACES the whole plan: steps you don't pass back with their id are deleted with their status and notes. Use it to write or deliberately rewrite a plan. To change an existing plan, use update_plan (many steps at once: statuses, notes, moves, phase renames), update_step (one step) or add_steps (append).
- Keep steps current with update_step (in_progress when you start, done when finished). Before asking the user a question and waiting for the answer, mark the current step blocked with a note saying what you need; set it back to in_progress once answered. move_task to review when the work is done (with auto-review on, finish the review loop first), link PRs when opened; done when merged/verified.
- Link the Jira issue at creation: pass its key in links (create_task/add_to_backlog) or call link. Keys in the title are linked automatically. Task results list any "Missing links"; act on them.
- Local review: when move_task to review says a review round is open, run the loop it describes (a fresh reviewer subagent per round, submit_review, resolve_finding, start_review) before opening the PR.
- Already delivered by another task, a duplicate, or no longer wanted? close_task (no plan needed) instead of archiving.
- End each session with add_note: a handover of what's done, what's left and the next action.
- In T3 Code: call t3_thread_configuration (threadId) and t3_environment_read (environmentId) once and pass them as t3Thread to create_task/add_to_backlog, and to link whenever you start or resume an existing task in this thread.`;

/** Generic HTTP client user agents that say nothing about which agent is calling. */
const GENERIC_AGENTS =
  /^(node|undici|node-fetch|axios|python|python-httpx|aiohttp|go-http-client|reqwest|curl|mozilla|okhttp)$/i;

/**
 * Stateless mode has no session, so the initialize request's clientInfo is not available on later
 * tool calls. Fall back to the first User-Agent product token when it names a real client.
 */
function actorFromUserAgent(userAgent: string | null): string | undefined {
  const product = userAgent?.trim().split(/[\s/]/)[0];
  if (!product || GENERIC_AGENTS.test(product)) return undefined;
  return product.slice(0, 64);
}

function createMcpServer(ctx: AppContext, request: Request): McpServer {
  const server = new McpServer({ name: BRAND.id, version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const fallbackActor = actorFromUserAgent(request.headers.get("user-agent"));
  const tc: ToolContext = {
    ctx,
    services: ctx.services,
    actor: (explicit) => explicit?.trim() || server.server.getClientVersion()?.name || fallbackActor || "agent",
  };
  registerReadTools(server, tc);
  registerTaskTools(server, tc);
  registerPlanTools(server, tc);
  registerLinkTools(server, tc);
  registerReviewTools(server, tc);
  return server;
}

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This MCP server is stateless; use POST." },
      id: null,
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST" } },
  );

/**
 * Mounts the MCP endpoint at /mcp: streamable HTTP in stateless mode, a fresh server and
 * transport per request (the SDK's documented stateless pattern). JSON responses rather than
 * SSE, since no tool streams progress.
 */
export function registerMcp(app: Hono, ctx: AppContext): void {
  app.post("/mcp", async (c) => {
    const server = createMcpServer(ctx, c.req.raw);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
