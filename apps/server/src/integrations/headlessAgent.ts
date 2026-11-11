import type { RunModelUsage } from "./runUsage.ts";
import {
  ACTOR_HEADER,
  BRAND,
  HEADLESS_CAPABILITIES,
  type AgentHarness,
  type CliEffort,
  type DriverCapabilities,
} from "@repo/contracts";
import { claudeFailure, readClaudeResult, runClaude } from "./claudeCli.ts";
import { RUN_SERVER_NAME } from "../mcp/runTokens.ts";

// Autopilot's headless agent: Claude Code (`claude -p`) doing real work in a worktree the board made for the run.
// Unlike the board's reviewer it keeps its session, so the user can resume it with `claude --resume <id>`, and it
// reaches the board over the user's own MCP config.

/**
 * How much a headless agent may do: work on the code, only read it (and call the extra tools it is given), or have
 * no tools at all and answer from its prompt (no built-in tools, no MCP servers).
 */
export type AgentAccess = "edit" | "read-only" | "none";

/** Read files, search, and read-only git. Everything else is denied by `--permission-mode dontAsk`. */
export const READ_ONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff *)",
  "Bash(git log *)",
  "Bash(git show *)",
  "Bash(git status *)",
  "Bash(git merge-base *)",
  "Bash(git rev-parse *)",
];

/** What an agent with edit access may use without asking. `--permission-mode acceptEdits` covers file edits. */
export const EDIT_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "TodoWrite",
  "Task",
  "WebFetch",
  "WebSearch",
  // This board, so the agent can move its task, keep its plan current and link its PR.
  `mcp__${BRAND.id}`,
];

/**
 * Git and gh commands no Autopilot agent may run, whatever it was allowed: force-pushes, pushes that delete or
 * mirror refs, pushes to the default branch, and merging pull requests (docs/decisions/0008-autopilot-engine.md).
 * Deny rules win over allow rules. They match the command as written, so they are a guard rail, not a sandbox:
 * the prompt says the same, and the worktree's branch never tracks the default branch.
 */
export function pushDenyRules(defaultBranch: string | null): string[] {
  // `git -C <dir> push` is written differently, so it needs its own rules.
  const push = (pattern: string) =>
    ["git push", "git -C * push"].flatMap((cmd) => [`Bash(${cmd} ${pattern})`, `Bash(${cmd} * ${pattern})`]);
  const rules = [
    ...push("--force*"),
    ...push("-f"),
    ...push("-f *"),
    // A refspec starting with + forces that ref.
    ...push("+*"),
    ...push("--mirror*"),
    ...push("--delete*"),
    // Not `:*` for `git push origin :branch`: a rule ending in `:*` is Claude Code's prefix syntax and would deny
    // every push.
    ...push("-d *"),
    "Bash(gh pr merge*)",
    "Bash(gh api *merge*)",
  ];
  if (defaultBranch) {
    for (const ref of [defaultBranch, `refs/heads/${defaultBranch}`]) {
      for (const pattern of [ref, `${ref} *`, `*:${ref}`, `*:${ref} *`]) {
        rules.push(...push(pattern));
      }
    }
  }
  return rules;
}

/**
 * What an agent that reads untrusted text may use, instead of the read-only list. The file tools reach only the working
 * directory (a bare `Read` reaches any file the user can). git is limited to three exact commands: `git diff`, `show`
 * and `log` take any path, so they read any file (a path outside the work tree makes `diff` compare files) and write
 * any file (`--output=`). The change itself comes from the board's run tools (a PR review's `pr_diff`).
 */
const UNTRUSTED_TOOLS = [
  "Read(./**)",
  "Grep(./**)",
  "Glob(./**)",
  "Bash(git rev-parse HEAD)",
  "Bash(git status --short)",
  "Bash(git log --oneline -20)",
];

export interface AgentArgsInput {
  access: AgentAccess;
  budgetUsd: number;
  /** The board assigns it, so the session can be linked before the run ends. */
  sessionId: string;
  /** As `--model` takes it; null keeps the CLI's default. */
  model: string | null;
  /** As `--effort` takes it; absent or null keeps the CLI's default. */
  effort?: CliEffort | null;
  /** The session's display name (`--name`), so it reads as something in `claude --resume` and Claude Code's UI. */
  name?: string | null;
  defaultBranch: string | null;
  /** Allowed on top of the access's own list, e.g. `Bash(gh pr review *)` for a read-only reviewer. */
  tools?: readonly string[];
  /** Denied on top of the push rules, e.g. one of the board's MCP tools the run may not use. */
  deniedTools?: readonly string[];
  /** A JSON schema the agent's final answer must match (`--json-schema`). */
  outputSchema?: object | null;
  /**
   * Where the schema was written, for a CLI that reads it from a file (`HeadlessDriver.schemaFile`); withDriverArgs
   * writes it.
   */
  outputSchemaPath?: string;
  /**
   * A read-only run held apart from the user's setup (the `readOnly` capability): none of their MCP servers, the
   * checkout's settings or a CLI's own hosted tools; only the run tools, when it has them. For the user's own input
   * (a task's diff, a settings question); `untrusted` locks down further. Read-only agents only.
   */
  isolated?: boolean;
  /** Nothing to resume: the CLI keeps no session (a reviewer's verdict, a settings answer). */
  ephemeral?: boolean;
  /**
   * The agent reads text anyone can write, so a prompt injection could try to steal or misuse what it can reach: it
   * gets no MCP servers (the board's included), no settings from the checkout, only exact git commands, and file tools
   * that reach only its own worktree. Read-only agents only.
   */
  untrusted?: boolean;
  /**
   * With `untrusted`: an MCP config file naming only this board's server, which the agent then gets (and no other
   * server: `--strict-mcp-config` still applies). For a read-only agent that reads untrusted text but works through the
   * board (Orchestrate). The caller narrows the board's own tools with `deniedTools`.
   */
  boardMcpConfig?: string;
  /**
   * The board's run tools (docs/decisions/0013-board-served-run-tools.md): the run's `/mcp/run` URL, and an MCP config
   * file naming only that server with the run's token (runToolsMcpConfig), for a CLI that reads one. The token itself
   * reaches a CLI that reads it from its environment as RUN_TOKEN_ENV. The run's tools are all allowed: the endpoint
   * serves only those its operation may use.
   */
  runTools?: { url: string; configPath: string };
}

/**
 * An MCP config with only this board's server, for `--mcp-config`. It carries the board's API token when one is set,
 * so it goes in a file of the runner's, not on the command line. With `actor`, the board records everything the run
 * writes as that actor, whatever the agent passes.
 */
export function boardMcpConfig(url: string, token: string | null, actor?: string): string {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(actor ? { [ACTOR_HEADER]: actor } : {}),
  };
  const server = { type: "http", url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  return JSON.stringify({ mcpServers: { [BRAND.id]: server } });
}

/**
 * The MCP config of a run's board-served tools, for `--mcp-config`: only the run's server, with its token in a header.
 * It goes in a file of the runner's, outside the worktree, never on the command line.
 */
export function runToolsMcpConfig(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: { [RUN_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } },
  });
}

/**
 * Environment for a run whose tools come from an MCP server it can't work without: one of the user's that its extra
 * tools name (a filled tool slot, say), or the board's run tools. `claude -p` connects MCP servers in the background,
 * so a slow one's tools may not be there on the first turn, and a locked-down run has no ToolSearch to find them
 * later; this makes it connect them first. Not for a run that gets no servers (`none`), nor for one that only needs
 * the board's, so those aren't held up by every other server the user has. A locked-down run with run tools has only
 * the board's local servers, so waiting costs it nothing.
 */
export function mcpWaitEnv(
  input: Pick<AgentArgsInput, "access" | "untrusted" | "tools"> & { runTools?: boolean | undefined },
): Record<string, string> {
  if (input.access === "none") return {};
  if (input.runTools) return { MCP_CONNECTION_NONBLOCKING: "false" };
  if (input.access === "read-only" && input.untrusted) return {};
  const board = `mcp__${BRAND.id}`;
  const userServer = (input.tools ?? []).some(
    (tool) => tool.startsWith("mcp__") && tool !== board && !tool.startsWith(`${board}__`),
  );
  return userServer ? { MCP_CONNECTION_NONBLOCKING: "false" } : {};
}

/** `claude -p` arguments for an Autopilot agent run. The prompt goes over stdin. */
export function agentArgs(input: AgentArgsInput): string[] {
  const readOnly = input.access === "read-only";
  const none = input.access === "none";
  const lockedDown = readOnly && input.untrusted;
  // Isolated but trusted: the reviewer's read-only list without the board, and no MCP servers but the run's.
  const isolated = readOnly && !input.untrusted && Boolean(input.isolated);
  // A no-tools run gets none, run tools included.
  const runTools = none ? null : (input.runTools ?? null);
  const mcpConfigs = [
    ...(runTools ? [runTools.configPath] : []),
    ...(lockedDown && input.boardMcpConfig ? [input.boardMcpConfig] : []),
  ];
  return [
    "-p",
    "--output-format",
    "json",
    ...(input.outputSchema ? ["--json-schema", JSON.stringify(input.outputSchema)] : []),
    // dontAsk denies everything not allowed; acceptEdits also takes file edits without asking.
    "--permission-mode",
    readOnly || none ? "dontAsk" : "acceptEdits",
    // No tools: an empty built-in list, and no MCP servers started, so the agent works from its prompt alone.
    ...(none ? ["--tools", "", "--strict-mcp-config"] : []),
    ...(none
      ? []
      : [
          "--allowedTools",
          ...(readOnly
            ? input.untrusted
              ? [...UNTRUSTED_TOOLS, ...(input.boardMcpConfig ? [`mcp__${BRAND.id}`] : [])]
              : isolated
                ? READ_ONLY_TOOLS
                : [...READ_ONLY_TOOLS, `mcp__${BRAND.id}`]
            : EDIT_TOOLS),
          ...(runTools ? [`mcp__${RUN_SERVER_NAME}`] : []),
          ...(input.tools ?? []),
        ]),
    "--disallowedTools",
    ...(readOnly ? ["Edit", "Write", "NotebookEdit"] : []),
    ...pushDenyRules(input.defaultBranch),
    ...(input.deniedTools ?? []),
    // No MCP servers, and none of the settings the checkout carries: a branch's .claude/settings.json could allow
    // anything or run hooks, for anyone who can push to it. The user's own settings stay (some set up the login), so
    // only the built-in tools it needs are available: a global allow rule for WebFetch or the like finds no tool.
    // With a board config or run tools, those are the only MCP servers it gets.
    ...(lockedDown
      ? [
          "--strict-mcp-config",
          ...(mcpConfigs.length > 0 ? ["--mcp-config", ...mcpConfigs] : []),
          "--setting-sources",
          "user",
          "--tools",
          "Read,Grep,Glob,Bash",
        ]
      : isolated
        ? [
            "--strict-mcp-config",
            ...(mcpConfigs.length > 0 ? ["--mcp-config", ...mcpConfigs] : []),
            "--setting-sources",
            "user",
          ]
        : // Any other run keeps the user's servers and gets the run's on top.
          mcpConfigs.length > 0
          ? ["--mcp-config", ...mcpConfigs]
          : []),
    "--max-budget-usd",
    String(input.budgetUsd),
    "--session-id",
    input.sessionId,
    // Nothing to resume: a no-tools run has no worktree or card, so its transcript would only pile up.
    ...(none || input.ephemeral ? ["--no-session-persistence"] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.name ? ["--name", input.name] : []),
  ];
}

/** How a headless agent run ended. */
export interface AgentOutcome {
  ok: boolean;
  /** Why it failed, when it did. */
  error: string | null;
  /** The agent's final message. */
  result: string | null;
  /** The structured output, when an output schema was given. */
  output: unknown;
  sessionId: string | null;
  costUsd: number | null;
  /** Tokens by model, as the run's own output reports them; empty when it reports none. */
  usage: RunModelUsage[];
}

/** Reads `--output-format json` stdout. A run that stopped (budget, turn limit) still reports what it cost. */
export function parseAgentOutput(stdout: string, wantsOutput: boolean): AgentOutcome {
  const out = readClaudeResult(stdout);
  const failed = out.isError || (wantsOutput && out.structuredOutput === undefined);
  return {
    ok: !failed,
    error: failed ? claudeFailure(out, "agent") : null,
    result: out.result,
    output: out.structuredOutput,
    sessionId: out.sessionId,
    costUsd: out.costUsd,
    usage: out.usage,
  };
}

export interface AgentJob {
  cli: string | null;
  /** The CLI's name on PATH when `cli` isn't set, and how errors name it. Claude Code's unless given. */
  command?: string;
  label?: string;
  cwd: string;
  prompt: string;
  args: string[];
  timeoutMs: number;
  /** Each line of stdout as it comes. */
  onStdoutLine?: (line: string) => void;
  /** Added to the server's environment, e.g. the push guard's (pushGuardEnv). */
  env?: Record<string, string>;
}

/** One harness's headless CLI: how to call it and how to read what it printed. */
export interface HeadlessDriver {
  harness: AgentHarness;
  /** Its name on PATH. */
  command: string;
  /**
   * The CLI reads the run tools' token from its environment (RUN_TOKEN_ENV) rather than from a config file. Only then
   * does the runner put it there, where every process the agent starts would inherit it.
   */
  runTokenFromEnv?: boolean;
  /** How runs and errors name it. */
  label: string;
  capabilities: DriverCapabilities;
  /** The CLI reads the output schema from a file (`outputSchemaPath`), which withDriverArgs writes. */
  schemaFile?: boolean;
  /** The argv for a run; the prompt goes over stdin. `sessionId` is ignored without `presetSessionId`. */
  args(input: AgentArgsInput): string[];
  /** The run's outcome; with the run's output schema, its structured output is checked for and read. */
  parse(stdout: string, outputSchema?: object | null): AgentOutcome;
  /** The session id a stdout line reports, for a CLI that picks its own. */
  sessionIdOf?(line: string): string | null;
}

/** Claude Code (`claude -p`): every capability. */
export const claudeDriver: HeadlessDriver = {
  harness: "claude-code",
  command: "claude",
  label: "Claude Code",
  capabilities: HEADLESS_CAPABILITIES["claude-code"],
  args: agentArgs,
  parse: (stdout, outputSchema) => parseAgentOutput(stdout, Boolean(outputSchema)),
};

/** Runs one headless agent to the end and returns its stdout. */
export type RunAgent = (job: AgentJob) => Promise<string>;

export const runHeadlessAgent: RunAgent = (job) =>
  // A missing credential must fail the push instead of waiting for input nobody will type.
  runClaude({ ...job, env: { ...process.env, ...job.env, GIT_TERMINAL_PROMPT: "0" } });
