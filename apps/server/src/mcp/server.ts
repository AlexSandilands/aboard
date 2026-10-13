import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AppContext } from "../app.ts";
import type { ToolContext } from "./shared.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerTaskTools } from "./tools/tasks.ts";
import { registerPlanTools } from "./tools/plans.ts";
import { registerLinkTools } from "./tools/links.ts";

const INSTRUCTIONS = `Taskboard is the user's local kanban board for tracking work across projects. Columns: Ideas -> Planned -> In Progress -> Review -> Done, one swimlane per project. Identify the project by passing workspacePath (your cwd).
- Orient with board_overview or list_tasks; ALWAYS call get_task before resuming an existing task.
- Ideas are cheap: create_idea mid-task for anything worth doing later, then carry on.
- A task can't leave Ideas without a plan: set_plan (phases of 3-8 concrete, verifiable steps) before moving it to planned/in_progress. create_task makes a planned task in one call.
- Keep steps current with update_step (in_progress when you start, done when finished). link PRs when opened and move_task to review; done when merged/verified.
- End each session with add_note: a handover of what's done, what's left and the next action.
- In T3 Code: call t3_thread_configuration (threadId) and t3_environment_read (environmentId) once and pass them as t3Thread to create_task or link.`;

/** Generic HTTP client user agents that say nothing about which agent is calling. */
const GENERIC_AGENTS = /^(node|undici|node-fetch|axios|python|python-httpx|aiohttp|go-http-client|reqwest|curl|mozilla|okhttp)$/i;

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
  const server = new McpServer({ name: "taskboard", version: "0.1.0" }, { instructions: INSTRUCTIONS });
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
  return server;
}

const methodNotAllowed = () =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This MCP server is stateless; use POST." }, id: null }),
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
