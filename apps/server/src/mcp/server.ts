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
import { registerMergeTools } from "./tools/merge.ts";
import { registerReviewTools } from "./tools/reviews.ts";
import { registerThreadTools } from "./tools/threads.ts";

const INSTRUCTIONS = `${BRAND.name} is the user's local kanban board for tracking work across projects. Columns: Backlog -> Planned -> In Progress -> Review -> Done, one swimlane per project. Identify the project by passing workspacePath (your cwd).
- Orient with board_overview or list_tasks; ALWAYS call get_task before resuming an existing task.
- The backlog is cheap: add_to_backlog mid-task for anything worth doing later (an idea, a follow-up, a Jira ticket), then carry on.
- A task can't leave Backlog without a plan: set_plan (phases of 3-8 concrete, verifiable steps) before moving it to planned/in_progress. create_task makes a planned task in one call. When planning, also pass suggestedModel: the tier (light, standard or deep) the implementing session needs, judged by complexity and risk. If the result says the task has no labels, suggest 1-3 to the user (prefer labels already in use) and apply them with update_task once they agree.
- Showing the user a draft plan: print it in full as its own message first, and only then ask your questions (a question dialog is never where the plan lives). Once it is saved, end the turn restating what was saved: some apps collapse everything but a turn's last message.
- To plan several of a project's tasks with the user in one session, follow the prompt get_handoff_prompt(tasks: ["#3", "#4"]) returns; the board starts such sessions from a lane's Plan tasks.
- Autopilot can start flagged Planned tasks by itself. When a planning result says the Autopilot flag isn't set, ask the user whether to flag the task, then apply their answer with update_task(autopilot: "on" | "off"); never set it unasked. You can only flag tasks: Autopilot's own settings are the user's alone, and no tool changes them.
- Priority tasks show in a lane above every project, and Autopilot starts them first. Set it with update_task(priority: true | false), or priority on create_task / add_to_backlog, only when the user has asked for it.
- merge_task_pr merges a task's PR into the default branch, only for a task flagged with update_task(autoMerge: "on"), which you set only when the user says so. The board refuses, with the reason, until the PR is reviewed, green and mergeable; fix what it names or wait, and never merge with gh or git instead.
- set_plan REPLACES the whole plan: steps you don't pass back with their id are deleted with their status and notes. Use it to write or deliberately rewrite a plan. To change an existing plan, use update_plan (several changes at once: notes, moves, phase renames, statuses that really changed together), update_step (one step) or add_steps (append).
- Keep steps current with update_step (in_progress when you start, done when finished): update each step the moment it changes, one call per step, and never save the updates for the end of a phase. If steps can only be verified together, still mark each in_progress as you start it and done once it is written, with testing as its own step. Results point out when no step is in progress or the plan has gone stale. Before asking the user a question and waiting for the answer, mark the current step blocked with a note saying what you need; set it back to in_progress once answered. move_task to review when the work is done (with auto-review on, finish the review loop first, then always open the PR, or push to the one already linked), link PRs when opened; done when merged/verified.
- Link the Jira issue at creation: pass its key in links (create_task/add_to_backlog) or call link. Keys in the title are linked automatically. Task results list any "Missing links"; act on them.
- Local review: when move_task to review says a review round is open, run the loop it describes (a fresh reviewer subagent per round, submit_review, resolve_finding; the board opens the next round when you resolve the last blocking/major finding, and start_review hands you its brief) before opening the PR, never earlier: a PR opened before the loop ends is reviewed on GitHub too. When the loop ends (a clean round, or the round limit) always open the PR and link it, listing any findings still open in its description, unless the user asked you not to; if the task already has a PR, push to it instead.
- Epics group the tasks of a large feature in one project: create_epic (optionally with existing tasks), then pass epic: "#N" to create_task/add_to_backlog, or update_task(epic) to move a task in or out. An epic has no plan and no column of its own; its status follows its tasks, so plan, move and review the tasks. epic_overview (or get_task on the epic) shows how each task is getting on. To start an epic's tasks, use start_task_thread(task) when epic_overview says T3 Code is available (message_task_thread talks to the thread), else give each subagent get_handoff_prompt(task, subagent: true), or give the user get_handoff_prompt(task) to paste; a subagent stops at an open review round and reports back, and the orchestrator runs the loop with start_review.
- An epic is delivered through pull requests to main (the default: each task's PR goes to the default branch and the user merges it) or an integration branch (its tasks start from epic/<number>-<slug> and open their PRs against it, Autopilot merges each one there once it is reviewed and green, and the user merges the epic's one PR into the default branch). When a result says "Epic delivery not chosen", ask the user which they want and set it with update_task(epic, delivery) only once they've answered; never choose unasked. In an integration epic, branch from its branch and open your PR against it, as get_task's Delivery line says, and don't merge it yourself. Autopilot never merges into the default branch.
- Templates: the user keeps task templates (Bug, Spike, Feature, their own). list_templates shows them; pass template (a name) to add_to_backlog or create_task to start from one: its description, labels and plan fill in what you leave out, and what you pass wins. A template with a plan makes create_task's own plan optional. You can't create or edit templates.
- Tasks can block each other, across projects: pass blockedBy on create_task/add_to_backlog, or addBlockedBy / removeBlockedBy on update_task. A task is blocked while any blocker isn't Done (get_task lists "Blocked by" and "Blocks", list_tasks and epic_overview show "blocked by #N"). Don't start a blocked task: tell the user what it waits on, or work a blocker. Cycles are refused.
- Already delivered by another task, a duplicate, or no longer wanted? close_task (no plan needed) instead of archiving.
- End each session with add_note: a handover of what's done, what's left and the next action.
- In T3 Code: call t3_thread_configuration (threadId) and t3_environment_read (environmentId) once and pass them as t3Thread to create_task/add_to_backlog, and to link whenever you start or resume an existing task in this thread.
- In Claude Code or Copilot CLI (inside T3 Code too): when you start or resume a task, link your own session with link(agentSession: {harness, sessionId, cwd}, label); the id is $CLAUDE_CODE_SESSION_ID or $COPILOT_AGENT_SESSION_ID. The user can then see it running and reopen it in a terminal from the board. Give it a short label saying what this session does, such as "Implementing #107", "Planning #107" or, for an epic you orchestrate, "Orchestrating #107": it is the name the board shows (link again with a new label when the work changes). A subagent has the same session id as the session that started it, so only the main session links; a subagent must never link or relabel it.`;

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
    client: () => server.server.getClientVersion()?.name || fallbackActor,
  };
  registerReadTools(server, tc);
  registerTaskTools(server, tc);
  registerPlanTools(server, tc);
  registerLinkTools(server, tc);
  registerMergeTools(server, tc);
  registerReviewTools(server, tc);
  registerThreadTools(server, tc);
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
