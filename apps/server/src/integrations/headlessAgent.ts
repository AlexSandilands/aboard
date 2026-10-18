import { BRAND } from "@repo/contracts";
import { claudeFailure, readClaudeResult, runClaude } from "./claudeCli.ts";
import { READ_ONLY_TOOLS } from "./headlessReview.ts";

// Autopilot's headless agent: Claude Code (`claude -p`) doing real work in a worktree the board made for the run.
// Unlike the board's reviewer it keeps its session, so the user can resume it with `claude --resume <id>`, and it
// reaches the board over the user's own MCP config.

/**
 * How much a headless agent may do: work on the code, only read it (and call the extra tools it is given), or have
 * no tools at all and answer from its prompt (no built-in tools, no MCP servers).
 */
export type AgentAccess = "edit" | "read-only" | "none";

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
 * any file (`--output=`). The change itself comes from `gh pr diff`, which the caller allows.
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
}

/**
 * An MCP config with only this board's server, for `--mcp-config`. It carries the board's API token when one is set,
 * so it goes in a file of the runner's, not on the command line.
 */
export function boardMcpConfig(url: string, token: string | null): string {
  const server = { type: "http", url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) };
  return JSON.stringify({ mcpServers: { [BRAND.id]: server } });
}

/** `claude -p` arguments for an Autopilot agent run. The prompt goes over stdin. */
export function agentArgs(input: AgentArgsInput): string[] {
  const readOnly = input.access === "read-only";
  const none = input.access === "none";
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
              : [...READ_ONLY_TOOLS, `mcp__${BRAND.id}`]
            : EDIT_TOOLS),
          ...(input.tools ?? []),
        ]),
    "--disallowedTools",
    ...(readOnly ? ["Edit", "Write", "NotebookEdit"] : []),
    ...pushDenyRules(input.defaultBranch),
    ...(input.deniedTools ?? []),
    // No MCP servers, and none of the settings the checkout carries: a branch's .claude/settings.json could allow
    // anything or run hooks, for anyone who can push to it. The user's own settings stay (some set up the login), so
    // only the built-in tools it needs are available: a global allow rule for WebFetch or the like finds no tool.
    // With a board config, that board's server is the one MCP server it gets.
    ...(readOnly && input.untrusted
      ? [
          "--strict-mcp-config",
          ...(input.boardMcpConfig ? ["--mcp-config", input.boardMcpConfig] : []),
          "--setting-sources",
          "user",
          "--tools",
          "Read,Grep,Glob,Bash",
        ]
      : []),
    "--max-budget-usd",
    String(input.budgetUsd),
    "--session-id",
    input.sessionId,
    // Nothing to resume: a no-tools run has no worktree or card, so its transcript would only pile up.
    ...(none ? ["--no-session-persistence"] : []),
    ...(input.model ? ["--model", input.model] : []),
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
  };
}

export interface AgentJob {
  cli: string | null;
  cwd: string;
  prompt: string;
  args: string[];
  timeoutMs: number;
}

/** Runs one headless agent to the end and returns its stdout. */
export type RunAgent = (job: AgentJob) => Promise<string>;

export const runHeadlessAgent: RunAgent = (job) =>
  // A missing credential must fail the push instead of waiting for input nobody will type.
  runClaude({ ...job, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
