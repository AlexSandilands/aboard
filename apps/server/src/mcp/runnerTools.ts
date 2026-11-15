import { CallToolReply, taskLabel } from "@repo/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, findProject, textResult, type ToolContext } from "./shared.ts";

// The tools on a runner (docs/features/remote-machines.md#tools-on-a-machine). Agents there call 127.0.0.1 as on a
// board, and the tools are the same ones: they act on the tasks the runner holds. What differs is decided here,
// before a tool runs: a read of anything else is passed to the board, a change to anything else is refused, and a
// new task gets its number from the board when the board can be reached.

/**
 * Tools that only read, which a runner may pass to its board and a board runs for a runner. A tool not listed is
 * never run on a machine's say-so.
 */
export const RUNNER_READ_TOOLS: ReadonlySet<string> = new Set([
  "board_overview",
  "board_activity",
  "list_projects",
  "list_templates",
  "list_tasks",
  "get_task",
  "epic_overview",
  "get_handoff_prompt",
  "list_editable_prompts",
  "get_editable_prompt",
]);

/** The read tools that list tasks: answered here, they show only what this machine holds, and say so. */
const TASK_LISTS: ReadonlySet<string> = new Set(["board_overview", "board_activity", "list_tasks"]);

/** Tools that make a task, which takes a number. */
const CREATING_TOOLS: ReadonlySet<string> = new Set(["add_to_backlog", "create_task"]);

/** Tools that act on the board itself (its threads, Autopilot, pull requests, prompts), which a runner has none of. */
const BOARD_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "create_epic",
  "merge_task_pr",
  "start_task_thread",
  "message_task_thread",
  "retry_autopilot_run",
  "draft_automation",
  "suggest_change",
  "get_session_transcript",
]);

export const RUNNER_INSTRUCTIONS =
  "\n- This server runs on a machine working for the user's board. It holds only the tasks the board handed to it: " +
  "those you can change as usual, and every change reaches the board. Other tasks can be read while the board is " +
  "reachable (the read is passed on to it) and can't be changed from here. A task you create here belongs to this " +
  "machine until the board takes it back; made while the board can't be reached, it gets the machine's prefix in " +
  'its number ("#E7"), which it keeps. Epics, Autopilot, threads and merging are the board\'s.';

type Args = Record<string, unknown>;

/** The task references a call names, wherever a tool takes them. */
function taskRefs(args: Args): string[] {
  const refs: string[] = [];
  for (const key of ["task", "epic"]) if (typeof args[key] === "string") refs.push(args[key]);
  if (Array.isArray(args.tasks)) refs.push(...args.tasks.filter((t): t is string => typeof t === "string"));
  return refs;
}

/**
 * Wraps every tool registered on `server` after this call, for a runner. Each call is looked at first and either
 * answered here (passed to the board, or refused) or left to the tool.
 */
export function guardRunnerTools(server: McpServer, tc: ToolContext): void {
  const { services } = tc;
  const { bridge } = tc.ctx.integrations.runnerHost;
  const machine = () => services.settings.get().machineName;

  /** What a reference names here: a task this machine holds, one it only knows of, or nothing. */
  const known = (ref: string): { held: boolean; label: string } => {
    try {
      const task = services.tasks.summary(services.tasks.resolveId(ref));
      return { held: services.workingCopies.role(task.id) === "held", label: taskLabel(task) };
    } catch {
      return { held: false, label: ref.startsWith("#") || ref.length > 12 ? ref : `#${ref}` };
    }
  };

  /** The call as the board should run it: a folder here names the board's project by its id. */
  const forBoard = (args: Args): Args | null => {
    if (typeof args.workspacePath !== "string") return args;
    const project = findProject(services, { workspacePath: args.workspacePath });
    const boardId = project ? services.workingCopies.boardProjectId(project.id) : null;
    if (!boardId) return null;
    const { workspacePath: _path, ...rest } = args;
    return { ...rest, projectId: boardId };
  };

  const passOn = async (name: string, args: Args): Promise<CallToolResult> => {
    const reply = CallToolReply.parse(await bridge.request("callTool", { name, arguments: args, actor: tc.actor() }));
    return reply.isError ? errorResult(reply.text) : textResult(reply.text);
  };

  /** The answer to give without running the tool, or null to run it. */
  const before = async (name: string, args: Args): Promise<CallToolResult | null> => {
    if (BOARD_ONLY_TOOLS.has(name)) {
      return errorResult(
        `CONFLICT: ${name} works on the user's board, not on ${machine()}, a machine that holds tasks for it.`,
      );
    }
    const refs = taskRefs(args).map(known);
    const foreign = refs.filter((ref) => !ref.held);

    if (RUNNER_READ_TOOLS.has(name)) {
      // What this machine holds is read here: its copy is the newest there is.
      if (refs.length > 0 && foreign.length === 0) return null;
      const passed = forBoard(args);
      if (bridge.reachable() && passed) {
        try {
          return await passOn(name, passed);
        } catch {
          // The board went away between the check and the answer: as below.
        }
      }
      if (foreign.length > 0) {
        return errorResult(
          `CONFLICT: ${foreign.map((f) => f.label).join(", ")} isn't held by ${machine()}, and the board can't be ` +
            "reached from it right now, so it can't be read here. Try again once the board is back.",
        );
      }
      return null;
    }

    const target = typeof args.task === "string" ? known(args.task) : null;
    if (target && !target.held) {
      return errorResult(
        `CONFLICT: ${target.label} isn't held by ${machine()}, so it can't be changed here; only the tasks handed ` +
          "to this machine can. Change it on the board.",
      );
    }

    if (CREATING_TOOLS.has(name) && bridge.reachable()) {
      try {
        const { number } = (await bridge.request("allocateNumber", {})) as { number: number };
        if (Number.isSafeInteger(number)) services.workingCopies.offerNumber(number);
      } catch {
        // The task takes the machine's own prefixed number instead.
      }
    }
    return null;
  };

  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  type Handler = (args: Args, extra: unknown) => CallToolResult | Promise<CallToolResult>;
  server.registerTool = ((name: string, config: unknown, handler: Handler) =>
    register(name, config, async (args: Args, extra: unknown) => {
      const early = await before(name, args);
      if (early) return early;
      const result = await handler(args, extra);
      // A list answered here, without the board, is only this machine's part of it.
      if (TASK_LISTS.has(name) && taskRefs(args).length === 0 && !result.isError) {
        const first = result.content[0];
        if (first?.type === "text") {
          const why = bridge.reachable() ? "" : ": the board can't be reached from it right now";
          first.text = `This shows only the tasks ${machine()} holds${why}.\n\n${first.text}`;
        }
      }
      return result;
    })) as typeof server.registerTool;
}
