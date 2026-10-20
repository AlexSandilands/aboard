import { BRAND, type AgentHarness } from "@repo/contracts";
import {
  claudeDriver,
  type AgentArgsInput,
  type AgentOutcome,
  type DriverCapabilities,
  type HeadlessDriver,
} from "./headlessAgent.ts";

// Autopilot's headless runs on harnesses other than Claude Code: `codex exec` and the Copilot CLI. Neither can be held
// to as much as `claude -p` (structured output, the untrusted-input lockdown, a budget), so a run that needs one of
// those runs on Claude Code instead (headlessDriverFor). See docs/features/autopilot.md#runners.

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

const LIMITED: Omit<DriverCapabilities, "presetSessionId"> = {
  outputSchema: false,
  untrusted: false,
  noTools: false,
  toolRules: false,
  budget: false,
};

// ── Codex ────────────────────────────────────────────────────────────────

/**
 * `codex exec` arguments. Edit access runs without Codex's sandbox: its workspace-write sandbox keeps git's own
 * folders read-only (and a worktree's live outside it), so the agent couldn't commit or push. That is the access a
 * Claude Code edit run has too (Bash allowed outright); the push guard still refuses force, delete and default-branch
 * pushes, and only the prompt says not to run `gh pr merge`. Read-only runs keep the read-only sandbox. `-` reads the
 * prompt from stdin. Written from Codex's docs and source, not against a real Codex (#252).
 */
export function codexArgs(input: AgentArgsInput): string[] {
  return [
    "exec",
    "--json",
    // A task-less run works in an empty folder that isn't a repository.
    "--skip-git-repo-check",
    "--sandbox",
    input.access === "edit" ? "danger-full-access" : "read-only",
    ...(input.model ? ["--model", input.model] : []),
    "-",
  ];
}

/**
 * Reads `codex exec --json` stdout: `thread.started` names the session, each completed `agent_message` item is the
 * agent speaking (the last is its answer), and `turn.failed` or a top-level `error` is why it stopped.
 */
export function parseCodexOutput(stdout: string): AgentOutcome {
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
    } else if (e.type === "turn.failed") failure = text(field(e.error, "message")) ?? "the turn failed";
    else if (e.type === "error") failure ??= text(e.message) ?? "Codex reported an error";
    else if (e.type === "turn.completed") completed = true;
  }
  const failed = failure !== null || !completed;
  return {
    ok: !failed,
    error: failed ? clip(failure ?? (stdout.trim() ? "Codex ended before its turn completed" : "no output")) : null,
    result,
    output: undefined,
    sessionId,
    costUsd: null,
  };
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
  capabilities: { ...LIMITED, presetSessionId: false },
  args: codexArgs,
  parse: (stdout) => parseCodexOutput(stdout),
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
  capabilities: { ...LIMITED, presetSessionId: true },
  args: copilotArgs,
  parse: (stdout) => parseCopilotOutput(stdout),
};

// ── Choosing one ─────────────────────────────────────────────────────────

export const HEADLESS_DRIVERS: Record<AgentHarness, HeadlessDriver> = {
  "claude-code": claudeDriver,
  codex: codexDriver,
  "copilot-cli": copilotDriver,
};

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
}

/** What `needs` asks that the driver can't do, in words, or null when it can do all of it. */
export function missingCapability(driver: HeadlessDriver, needs: DriverNeeds): string | null {
  const c = driver.capabilities;
  if (needs.unguarded && needs.access === "edit" && !c.toolRules) {
    return "push rules of its own, as a run with no worktree has no push guard";
  }
  if (needs.outputSchema && !c.outputSchema) return "structured output";
  if (needs.untrusted && !c.untrusted) return "the lockdown for untrusted input";
  if (needs.access === "none" && !c.noTools) return "a run with no tools";
  if (((needs.tools?.length ?? 0) > 0 || (needs.deniedTools?.length ?? 0) > 0) && !c.toolRules) {
    return "its own tool rules";
  }
  return null;
}

/**
 * The driver for a run on `harness`: its own, or Claude Code's when the run needs something the harness can't do,
 * with a note saying so. A fallback runs on the Claude Code CLI's default model.
 */
export function headlessDriverFor(
  harness: AgentHarness,
  needs: DriverNeeds,
): { driver: HeadlessDriver; fallback: string | null } {
  const driver = HEADLESS_DRIVERS[harness];
  const missing = missingCapability(driver, needs);
  if (!missing) return { driver, fallback: null };
  return {
    driver: claudeDriver,
    fallback: `${driver.label} can't run this action headless (it needs ${missing}), so Claude Code ran it on its default model.`,
  };
}
