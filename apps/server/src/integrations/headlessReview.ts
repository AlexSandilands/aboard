import {
  BUILTIN_REVIEW_SKILL_BODY,
  FindingSeverity,
  type ReviewFindingInput,
  type ReviewSkillRef,
} from "@repo/contracts";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";

// The board's own reviewer: Claude Code headless (`claude -p`), read-only, with no MCP servers, returning its
// findings as structured output for the board to record. A fallback for rounds no agent runs.

const RUN_TIMEOUT_MS = 20 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;

/** What `--json-schema` asks the reviewer to return. */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One paragraph: overall verdict and the main risks." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: FindingSeverity.options },
          title: { type: "string" },
          file: { type: "string", description: "Repo-relative path." },
          line: { type: "integer", minimum: 1 },
          body: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "title"],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

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

export function headlessArgs(budgetUsd: number): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(REVIEW_OUTPUT_SCHEMA),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...READ_ONLY_TOOLS,
    "--disallowedTools",
    "Edit",
    "Write",
    "NotebookEdit",
    // No MCP servers: the user's config may register this board, and the reviewer must not record twice.
    "--strict-mcp-config",
    "--max-budget-usd",
    String(budgetUsd),
    "--no-session-persistence",
  ];
}

export interface HeadlessPromptInput {
  taskNumber: number;
  round: number;
  /** The task as get_task renders it: description, plan, notes and earlier rounds' findings. */
  taskText: string;
  skill: ReviewSkillRef;
  /** Branch the work forked from, for the diff. */
  baseRef: string | null;
}

/** The headless reviewer has no board tools, so the task comes inline and the findings go out as JSON. */
export function headlessPrompt({ taskNumber, round, taskText, skill, baseRef }: HeadlessPromptInput): string {
  const base = baseRef ?? "origin/HEAD (fall back to origin/main or main)";
  return [
    `Review the changes for task #${taskNumber}, review round ${round}. You are working in the task's checkout.`,
    // Only plain git commands are allowed: `$(...)` substitutions are denied, so the fork point is its own step.
    `Find where the branch forked with \`git merge-base HEAD ${base}\`, then read the changes with \`git diff <that commit>\` and \`git status\` for uncommitted work. Run each git command on its own. Don't edit any files.`,
    "Return your result as the structured output: a summary and one finding per problem (an empty list when the change is clean).",
    "",
    skill.source === "builtin"
      ? BUILTIN_REVIEW_SKILL_BODY.trim()
      : `How to review: read the skill "${skill.name}" at ${skill.path} and follow it, but return your result as the structured output instead of calling any tools to record it.`,
    "",
    "The task:",
    "---",
    taskText,
    "---",
  ].join("\n");
}

const HeadlessOutput = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
  structured_output: z
    .object({
      summary: z.string(),
      findings: z.array(
        z.object({
          severity: FindingSeverity,
          title: z.string().min(1),
          file: z.string().optional(),
          line: z.number().int().positive().optional(),
          body: z.string().optional(),
          suggestion: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export interface HeadlessReview {
  summary: string;
  findings: ReviewFindingInput[];
  costUsd: number | null;
}

/** Parses `--output-format json` stdout. Throws with the CLI's own message when it didn't produce findings. */
export function parseHeadlessOutput(stdout: string): HeadlessReview {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "");
  } catch {
    throw new Error(`Claude Code returned no JSON result: ${stdout.trim().slice(0, 200) || "(empty output)"}`);
  }
  const parsed = HeadlessOutput.safeParse(json);
  if (!parsed.success) throw new Error("Claude Code's result didn't match the expected shape");
  const out = parsed.data;
  if (out.is_error || !out.structured_output) {
    const why =
      out.subtype && out.subtype !== "success"
        ? out.subtype.replace(/_/g, " ")
        : (out.result ?? "no findings returned");
    throw new Error(`Claude Code's review failed: ${why}`);
  }
  return {
    summary: out.structured_output.summary,
    findings: out.structured_output.findings,
    costUsd: out.total_cost_usd ?? null,
  };
}

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

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  exe: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // .cmd/.bat shims (an npm-installed claude) only run through cmd.exe, which needs its own quoting.
    const child = /\.(cmd|bat)$/i.test(exe)
      ? spawn(process.env.ComSpec ?? "cmd.exe", cmdShimArgs(exe, args), {
          cwd: opts.cwd,
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(exe, args, { cwd: opts.cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Claude Code didn't finish within ${Math.round(opts.timeoutMs / 60_000)} minutes`));
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

export interface HeadlessJob {
  cli: string | null;
  cwd: string;
  prompt: string;
  budgetUsd: number;
}

export type RunHeadless = (job: HeadlessJob) => Promise<HeadlessReview>;

const cliPath = (cli: string | null): string => {
  const exe = resolveExecutable(cli?.trim() || "claude");
  if (!exe) throw new Error(cli ? `Claude Code CLI not found at ${cli}` : "Claude Code CLI (claude) not found on PATH");
  return exe;
};

/** Runs one headless review. The prompt goes over stdin, which has no length limit unlike the command line. */
export const runHeadlessReview: RunHeadless = async ({ cli, cwd, prompt, budgetUsd }) => {
  const result = await run(cliPath(cli), headlessArgs(budgetUsd), { cwd, input: prompt, timeoutMs: RUN_TIMEOUT_MS });
  if (result.stdout.trim()) return parseHeadlessOutput(result.stdout);
  throw new Error(`Claude Code exited with code ${result.code}: ${result.stderr.trim().slice(0, 300) || "no output"}`);
};

/** `claude --version`, for the settings' Test button. */
export async function headlessCliVersion(cli: string | null): Promise<{ path: string; version: string }> {
  const path = cliPath(cli);
  const result = await run(path, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `exited with code ${result.code}`);
  return { path, version: result.stdout.trim() };
}
