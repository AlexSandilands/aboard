import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";

// Running Claude Code headless (`claude -p`): finding the executable, spawning it on every platform, and reading
// its JSON result. Shared by the board's reviewer, the issue import and Autopilot's headless runs.

export const VERSION_TIMEOUT_MS = 15_000;

/**
 * Resolves a command name to an executable path the way the shell would, so it can be spawned without a shell
 * (no quoting of the JSON schema argument, no command injection). Paths are returned as given when they exist.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  const candidates = (base: string) => exts.map((ext) => base + ext);
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return candidates(command).find((c) => existsSync(c)) ?? null;
  }
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const found = candidates(join(dir, command)).find((c) => existsSync(c));
    if (found) return found;
  }
  return null;
}

// Adapted from cross-spawn (lib/util/escape.js, MIT, see NOTICE): quote each argument for the C runtime's
// argv parser, then escape cmd.exe's metacharacters twice: once for this command line, and once more because
// the shim expands `%*` again inside the batch file.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** `cmd.exe` arguments that run `exe` with `args` verbatim, spaces and quotes included. */
export function cmdShimArgs(exe: string, args: readonly string[]): string[] {
  const line = [exe.replace(CMD_META, "^$1"), ...args.map(escapeCmdArgument)].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

const formatDuration = (ms: number): string =>
  ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Ends the process and everything it started: an agent's shells and test runs must not outlive a timeout. */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    // child.kill() would end only the cmd.exe shim or claude itself, not the tools it started.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () =>
      child.kill(),
    );
    return;
  }
  child.kill();
}

function run(
  exe: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // .cmd/.bat shims (an npm-installed claude) only run through cmd.exe, which needs its own quoting.
    const child = /\.(cmd|bat)$/i.test(exe)
      ? spawn(process.env.ComSpec ?? "cmd.exe", cmdShimArgs(exe, args), {
          cwd: opts.cwd,
          env: opts.env,
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(exe, args, { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error(`Claude Code didn't finish within ${formatDuration(opts.timeoutMs)}`));
    }, opts.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}

const CliResult = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  structured_output: z.unknown().optional(),
});

/** The result line of `--output-format json` stdout. */
export interface ClaudeResult {
  isError: boolean;
  /** "success", or why the run stopped, e.g. "error_max_budget_usd". */
  subtype: string | null;
  /** The agent's final message. */
  result: string | null;
  sessionId: string | null;
  costUsd: number | null;
  structuredOutput: unknown;
}

/** Reads the result line (the last one: the CLI may print warnings first). Throws when there is none. */
export function readClaudeResult(stdout: string): ClaudeResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "");
  } catch {
    throw new Error(`Claude Code returned no JSON result: ${stdout.trim().slice(0, 200) || "(empty output)"}`);
  }
  const parsed = CliResult.safeParse(json);
  if (!parsed.success) throw new Error("Claude Code's result didn't match the expected shape");
  const out = parsed.data;
  return {
    isError: out.is_error ?? false,
    subtype: out.subtype ?? null,
    result: out.result ?? null,
    sessionId: out.session_id ?? null,
    costUsd: out.total_cost_usd ?? null,
    structuredOutput: out.structured_output,
  };
}

/** Why a run failed, in words: the subtype ("error max budget usd") or the CLI's own message. */
export const claudeFailure = (out: ClaudeResult, what: string): string =>
  out.subtype && out.subtype !== "success"
    ? out.subtype.replace(/_/g, " ")
    : (out.result ?? `no ${what} result returned`);

/**
 * Parses `--output-format json` stdout into the structured output (checked against `schema`) and its cost.
 * Throws with the CLI's own message when it didn't produce one. `what` names the job in that message.
 */
export function parseClaudeOutput<T>(
  stdout: string,
  schema: z.ZodType<T>,
  what: string,
): { output: T; costUsd: number | null } {
  const out = readClaudeResult(stdout);
  if (out.isError || out.structuredOutput === undefined) {
    throw new Error(`Claude Code's ${what} failed: ${claudeFailure(out, what)}`);
  }
  const output = schema.safeParse(out.structuredOutput);
  if (!output.success) throw new Error("Claude Code's result didn't match the expected shape");
  return { output: output.data, costUsd: out.costUsd };
}

export interface ClaudeJob {
  /** The CLI to run; null looks up `claude` on PATH. */
  cli: string | null;
  cwd: string;
  /** Goes over stdin, which has no length limit unlike the command line. */
  prompt: string;
  args: string[];
  timeoutMs: number;
  /** Replaces the environment; defaults to the server's. */
  env?: NodeJS.ProcessEnv;
}

const cliPath = (cli: string | null): string => {
  const exe = resolveExecutable(cli?.trim() || "claude");
  if (!exe) throw new Error(cli ? `Claude Code CLI not found at ${cli}` : "Claude Code CLI (claude) not found on PATH");
  return exe;
};

/** Runs one headless job and returns its stdout. Throws when the CLI can't run or printed nothing. */
export async function runClaude({ cli, cwd, prompt, args, timeoutMs, env }: ClaudeJob): Promise<string> {
  const result = await run(cliPath(cli), args, { cwd, input: prompt, timeoutMs, ...(env ? { env } : {}) });
  if (result.stdout.trim()) return result.stdout;
  throw new Error(`Claude Code exited with code ${result.code}: ${result.stderr.trim().slice(0, 300) || "no output"}`);
}

/** Runs `claude <args>` for its stdout (e.g. `mcp list`). Throws when the CLI can't run or exits non-zero. */
export async function claudeOutput(
  cli: string | null,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
): Promise<string> {
  const result = await run(cliPath(cli), args, opts);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `claude ${args[0] ?? ""} exited with code ${result.code}`);
  }
  return result.stdout;
}

/** `claude --version`, for the settings' Test button. */
export async function claudeCliVersion(cli: string | null): Promise<{ path: string; version: string }> {
  const path = cliPath(cli);
  const result = await run(path, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `exited with code ${result.code}`);
  return { path, version: result.stdout.trim() };
}
