import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, HEADLESS_CAPABILITIES, type AgentHarness, type OperationNeed } from "@repo/contracts";
import { RUN_SERVER_NAME, RUN_TOKEN_ENV } from "../mcp/runTokens.ts";
import { claudeDriver, type AgentArgsInput, type AgentOutcome, type HeadlessDriver } from "./headlessAgent.ts";
import { fromStrict, strictSchema } from "./strictSchema.ts";

// Autopilot's headless runs on harnesses other than Claude Code: `codex exec` and the Copilot CLI. Neither can be held
// to as much as `claude -p` (the untrusted-input lockdown, tool rules, a budget): what each can do is
// HEADLESS_CAPABILITIES in contracts, and the resolver only picks a provider that can do what the run needs
// (resolveOperationModel). See docs/features/autopilot.md#runners.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One JSONL line as an object with a `type`, or null for anything else (a warning the CLI printed, a blank). */
function event(line: string): { type: string; [key: string]: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as { type: string };
    }
  } catch {
    // Not JSON after all.
  }
  return null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const field = (value: unknown, key: string): unknown =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** An error's own text is cut here, as in claudeFailure. */
const MAX_FAILURE_TEXT = 500;
const clip = (message: string) =>
  message.length > MAX_FAILURE_TEXT ? `${message.slice(0, MAX_FAILURE_TEXT)}…` : message;

// ── Codex ────────────────────────────────────────────────────────────────

/**
 * `codex exec` arguments. Edit access runs without Codex's sandbox: its workspace-write sandbox keeps git's own
 * folders read-only (and a worktree's live outside it), so the agent couldn't commit or push. With both git dirs added
 * as writable roots it does commit and push over HTTPS (checked on codex-cli 0.166.0), but then only the worktree,
 * those roots and temp are writable: `~/.cache` and `~/.local/share` are read-only, where package managers keep their
 * stores, so an edit run that installs or tests would fail. Hence the sandbox stays off.
 * That is the access a Claude Code edit run has too (Bash allowed outright); the push guard still refuses force, delete
 * and default-branch pushes, and only the prompt says not to run `gh pr merge`. Read-only runs keep the read-only
 * sandbox (no writes, no network for its shell); an isolated or untrusted one also drops the user's config and rules
 * and Codex's hosted web search and apps (codexIsolationArgs). The schema goes in a file (`--output-schema`), in
 * strict mode. The effort is the config key `model_reasoning_effort` (`codex exec` has no flag for it). `-` reads the
 * prompt from stdin. Checked against codex-cli 0.166.0 (docs/features/autopilot.md#headless-drivers).
 */
export function codexArgs(input: AgentArgsInput): string[] {
  const edit = input.access === "edit";
  const isolated = !edit && Boolean(input.isolated || input.untrusted);
  return [
    "exec",
    "--json",
    // A task-less run works in an empty folder that isn't a repository.
    "--skip-git-repo-check",
    "--sandbox",
    edit ? "danger-full-access" : "read-only",
    ...(isolated ? codexIsolationArgs() : []),
    ...(input.ephemeral ? ["--ephemeral"] : []),
    ...(input.outputSchemaPath ? ["--output-schema", input.outputSchemaPath] : []),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["-c", `model_reasoning_effort=${input.effort}`] : []),
    ...(input.runTools ? codexRunToolsArgs(input.runTools.url, { configIgnored: isolated }) : []),
    "-",
  ];
}

/**
 * A read-only `codex exec` held apart from the user's setup: none of their `config.toml` (so none of their MCP
 * servers) or exec-policy rules, no hosted web search (a tool of the model's, outside the sandbox) and no apps
 * connector. Its read-only sandbox still reads any file the user can, so it isn't the untrusted lockdown.
 */
export function codexIsolationArgs(): string[] {
  return ["--ignore-user-config", "--ignore-rules", "-c", 'web_search="disabled"', "--disable", "apps"];
}

/**
 * The board's run tools for `codex exec`: none of the user's `config.toml` (so none of their MCP servers, the board's
 * included), and the run's endpoint as the one server. The token isn't on the command line, where any local process
 * can read it: Codex sends the RUN_TOKEN_ENV variable as the bearer token. `--ignore-user-config` still uses the
 * login under CODEX_HOME. Its tools are approved up front: in the read-only sandbox Codex otherwise asks before a tool
 * call without `readOnlyHint`, and with nobody to answer the call fails; the endpoint serves only the tools the run may
 * use. Checked against codex-cli 0.166.0 (docs/features/autopilot.md#headless-drivers).
 */
export function codexRunToolsArgs(url: string, opts: { configIgnored?: boolean } = {}): string[] {
  const server = `mcp_servers.${RUN_SERVER_NAME}`;
  return [
    ...(opts.configIgnored ? [] : ["--ignore-user-config"]),
    "-c",
    `${server}.url=${JSON.stringify(url)}`,
    "-c",
    `${server}.bearer_token_env_var=${JSON.stringify(RUN_TOKEN_ENV)}`,
    "-c",
    `${server}.default_tools_approval_mode="approve"`,
  ];
}

/**
 * An error's text. A refusal from the API arrives as the response body in a string
 * (`{"type":"error","error":{"message":"…"},"status":400}`): its own message is what the board shows.
 */
function codexErrorText(message: unknown): string | null {
  const raw = text(message);
  if (!raw?.trimStart().startsWith("{")) return raw;
  try {
    return text(field(field(JSON.parse(raw), "error"), "message")) ?? raw;
  } catch {
    return raw;
  }
}

/**
 * Reads `codex exec --json` stdout: `thread.started` names the session, each completed `agent_message` item is the
 * agent speaking (the last is its answer), and `turn.failed` or a top-level `error` is why it stopped. With an output
 * schema the answer is the structured output, as JSON written to the strict form of the schema (strictSchema).
 */
export function parseCodexOutput(stdout: string, outputSchema?: object | null): AgentOutcome {
  let sessionId: string | null = null;
  let result: string | null = null;
  let failure: string | null = null;
  let completed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const e = event(line);
    if (!e) continue;
    if (e.type === "thread.started") sessionId ??= codexSessionId(line);
    else if (e.type === "item.completed" && field(e.item, "type") === "agent_message") {
      result = text(field(e.item, "text")) ?? result;
    } else if (e.type === "turn.failed") {
      failure = codexErrorText(field(e.error, "message")) ?? "the turn failed";
    } else if (e.type === "error") failure ??= codexErrorText(e.message) ?? "Codex reported an error";
    else if (e.type === "turn.completed") completed = true;
  }
  let output: unknown;
  if (outputSchema && failure === null && completed) {
    output = structuredAnswer(result, outputSchema);
    if (output === undefined) failure = "its answer wasn't the JSON its output schema asks for";
  }
  const failed = failure !== null || !completed;
  return {
    ok: !failed,
    error: failed ? clip(failure ?? (stdout.trim() ? "Codex ended before its turn completed" : "no output")) : null,
    result,
    output,
    sessionId,
    costUsd: null,
  };
}

/** The answer read as JSON and given back the original schema's shape (fromStrict), or undefined when it isn't JSON. */
function structuredAnswer(result: string | null, outputSchema: object): unknown {
  if (result === null) return undefined;
  try {
    return fromStrict(outputSchema, JSON.parse(result));
  } catch {
    return undefined;
  }
}

/** The thread id of a `thread.started` line. */
export function codexSessionId(line: string): string | null {
  const e = event(line);
  const id = e?.type === "thread.started" ? text(e.thread_id) : null;
  return id && UUID.test(id) ? id.toLowerCase() : null;
}

export const codexDriver: HeadlessDriver = {
  harness: "codex",
  command: "codex",
  label: "Codex",
  runTokenFromEnv: true,
  capabilities: HEADLESS_CAPABILITIES.codex,
  schemaFile: true,
  args: codexArgs,
  parse: parseCodexOutput,
  sessionIdOf: codexSessionId,
};

// ── Copilot CLI ──────────────────────────────────────────────────────────

/** What a read-only Copilot run may run in the shell without asking: git commands that only read. */
const COPILOT_READ_ONLY_SHELL = ["git status", "git log", "git diff", "git show", "git rev-parse"].map(
  (cmd) => `shell(${cmd})`,
);

/**
 * Copilot CLI arguments. Its rules match a shell command by its first-level subcommand (`git push`, `gh pr merge`), so
 * it can refuse merging but not a force-push alone: the worktree's pre-push hook refuses those. Deny rules win over
 * allow rules. The prompt goes over stdin.
 */
export function copilotArgs(input: AgentArgsInput): string[] {
  const edit = input.access === "edit";
  const allow = edit ? ["write", "shell", BRAND.id] : [...COPILOT_READ_ONLY_SHELL, BRAND.id];
  const deny = ["shell(gh pr merge)", ...(edit ? [] : ["write"])];
  return [
    "--output-format",
    "json",
    // Nobody is there to answer.
    "--no-ask-user",
    "--session-id",
    input.sessionId,
    ...allow.flatMap((rule) => ["--allow-tool", rule]),
    ...deny.flatMap((rule) => ["--deny-tool", rule]),
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--reasoning-effort", input.effort] : []),
    ...(input.name ? ["--name", input.name] : []),
  ];
}

/**
 * Reads `--output-format json` stdout: the last `assistant.message` with text (or the summary of
 * `session.task_complete`) is the answer, `session.start` names the session, and `session.error` is why it stopped.
 */
export function parseCopilotOutput(stdout: string): AgentOutcome {
  let sessionId: string | null = null;
  let result: string | null = null;
  let failure: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const e = event(line);
    if (!e) {
      // The CLI prints a fatal error as text, e.g. "Error: Access denied by policy settings".
      const plain = line.trim();
      if (plain.startsWith("Error:")) failure ??= plain.slice("Error:".length).trim() || plain;
      continue;
    }
    if (e.type === "session.start") {
      const id = text(field(e.data, "sessionId"));
      if (id && UUID.test(id)) sessionId = id.toLowerCase();
    } else if (e.type === "assistant.message") result = text(field(e.data, "content")) ?? result;
    else if (e.type === "session.task_complete") result = text(field(e.data, "summary")) ?? result;
    else if (e.type === "session.error") failure = text(field(e.data, "message")) ?? "Copilot reported an error";
  }
  const failed = failure !== null || result === null;
  return {
    ok: !failed,
    error: failed ? clip(failure ?? "no result returned") : null,
    result,
    output: undefined,
    sessionId,
    costUsd: null,
  };
}

export const copilotDriver: HeadlessDriver = {
  harness: "copilot-cli",
  command: "copilot",
  label: "Copilot CLI",
  capabilities: HEADLESS_CAPABILITIES["copilot-cli"],
  args: copilotArgs,
  parse: (stdout) => parseCopilotOutput(stdout),
};

// ── Choosing one ─────────────────────────────────────────────────────────

export const HEADLESS_DRIVERS: Record<AgentHarness, HeadlessDriver> = {
  "claude-code": claudeDriver,
  codex: codexDriver,
  "copilot-cli": copilotDriver,
};

/** The driver of the provider an operation resolved to. */
export const headlessDriverFor = (harness: AgentHarness): HeadlessDriver => HEADLESS_DRIVERS[harness];

/**
 * Calls `run` with the driver's argv for `input`. A CLI that reads its output schema from a file (Codex) gets the
 * schema, in strict form, in a folder of its own outside the run's working folder, removed once `run` settles.
 */
export async function withDriverArgs<T>(
  driver: HeadlessDriver,
  input: AgentArgsInput,
  run: (args: string[]) => Promise<T>,
): Promise<T> {
  if (!driver.schemaFile || !input.outputSchema) return run(driver.args(input));
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.id}-schema-`));
  try {
    const outputSchemaPath = join(dir, "schema.json");
    await writeFile(outputSchemaPath, JSON.stringify(strictSchema(input.outputSchema)));
    return await run(driver.args({ ...input, outputSchemaPath }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** What a run asks of its driver. */
export interface DriverNeeds {
  access: AgentArgsInput["access"];
  outputSchema?: object | null | undefined;
  untrusted?: boolean | undefined;
  tools?: readonly string[] | undefined;
  deniedTools?: readonly string[] | undefined;
  /**
   * The run works where no push guard is installed (a task-less run, in an empty folder): only Claude Code's own deny
   * rules can keep an editing agent from force-pushing or merging there.
   */
  unguarded?: boolean | undefined;
  /** The run reads through the board's run tools. */
  runTools?: boolean | undefined;
}

/** What a run asks of its driver, as the operation needs the resolver checks providers against. */
export function driverNeeds(needs: DriverNeeds): OperationNeed[] {
  const out: OperationNeed[] = [];
  if (needs.access === "edit") out.push("edit");
  if (needs.access === "none") out.push("noTools");
  if (needs.outputSchema) out.push("outputSchema");
  if (needs.untrusted) out.push("untrusted");
  if (needs.runTools) out.push("runTools");
  // Only Claude Code's own deny rules keep an editing agent with no push guard from force-pushing or merging.
  const unguardedEdit = needs.unguarded && needs.access === "edit";
  if (unguardedEdit || (needs.tools?.length ?? 0) > 0 || (needs.deniedTools?.length ?? 0) > 0) out.push("toolRules");
  return out;
}
