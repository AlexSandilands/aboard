import type { RunModelUsage } from "./runUsage.ts";
import {
  type AgentHarness,
  BUILTIN_REVIEW_SKILL_BODY,
  type CliEffort,
  FindingSeverity,
  type ReviewFindingInput,
  type ReviewSkillRef,
} from "@repo/contracts";
import { z } from "zod";
import { parseClaudeOutput, runClaude } from "./claudeCli.ts";
import { READ_ONLY_TOOLS, type RunAgent } from "./headlessAgent.ts";
import { headlessDriverFor } from "./headlessDrivers.ts";
import { runStructured } from "./structuredRun.ts";

// The board's own reviewer: a headless CLI on the board reviewer's provider (`claude -p` or `codex exec`), read-only
// and held apart from the user's MCP servers, returning its findings as structured output for the board to record. A
// fallback for rounds no agent runs.

const RUN_TIMEOUT_MS = 20 * 60_000;

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

export function headlessArgs(
  budgetUsd: number,
  model: string | null = null,
  effort: CliEffort | null = null,
  /** Folders outside the checkout the reviewer may read, such as the task's screenshots. */
  addDirs: readonly string[] = [],
): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
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
    ...(addDirs.length ? ["--add-dir", ...addDirs] : []),
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
  /** Whether the task has images attached (listed in `taskText` with their paths): the reviewer opens them. */
  hasImages?: boolean;
}

/** The headless reviewer has no board tools, so the task comes inline and the findings go out as JSON. */
export function headlessPrompt({
  taskNumber,
  round,
  taskText,
  skill,
  baseRef,
  hasImages,
}: HeadlessPromptInput): string {
  const base = baseRef ?? "origin/HEAD (fall back to origin/main or main)";
  return [
    `Review the changes for task #${taskNumber}, review round ${round}. You are working in the task's checkout.`,
    // Only plain git commands are allowed: `$(...)` substitutions are denied, so the fork point is its own step.
    `Find where the branch forked with \`git merge-base HEAD ${base}\`, then read the changes with \`git diff <that commit>\` and \`git status\` for uncommitted work. Run each git command on its own. Don't edit any files.`,
    ...(hasImages
      ? [
          "The task has images, listed under Images in the task text with their file paths. Some may be the bug report's own picture; the author's captures are the ones written into the plan steps' notes. Open each one (with the Read tool, or your own way of viewing an image) and look at it: record a finding for any that shows a visual bug, or when the states the change introduced aren't covered, and a major one for a ui task with no capture in its steps.",
        ]
      : []),
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

const ReviewOutput = z.object({
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
});

export interface HeadlessReview {
  summary: string;
  findings: ReviewFindingInput[];
  costUsd: number | null;
  /** Tokens by model, as the reviewer's output reports them; absent from fakes. */
  usage?: RunModelUsage[];
}

/** Parses `--output-format json` stdout. Throws with the CLI's own message when it didn't produce findings. */
export function parseHeadlessOutput(stdout: string): HeadlessReview {
  const { output, costUsd, usage } = parseClaudeOutput(stdout, ReviewOutput, "review");
  return { summary: output.summary, findings: output.findings, costUsd, usage };
}

export interface HeadlessJob {
  /** The board reviewer's provider, as the resolver picked it; Claude Code when absent. */
  provider?: AgentHarness;
  cli: string | null;
  cwd: string;
  prompt: string;
  budgetUsd: number;
  /** As `--model` takes it; null keeps the CLI's default. */
  model: string | null;
  /** As `--effort` takes it; absent or null keeps the CLI's default. */
  effort?: CliEffort | null;
  /** Extra folders the reviewer may read, as `--add-dir` takes them. */
  addDirs?: readonly string[];
}

export type RunHeadless = (job: HeadlessJob) => Promise<HeadlessReview>;

/**
 * The headless review on the job's provider. Claude Code keeps its own argv (headlessArgs: its read-only tool list,
 * extra folders and budget). Any other driver runs read-only and isolated (no writes, no network, none of the user's
 * MCP servers), with no session kept; its sandbox reads any file, so the task's images need no extra folder.
 */
export function createHeadlessReviewer(runAgent?: RunAgent): RunHeadless {
  return async ({ provider = "claude-code", cli, cwd, prompt, budgetUsd, model, effort, addDirs }) => {
    if (provider === "claude-code") {
      const args = headlessArgs(budgetUsd, model, effort, addDirs);
      const stdout = runAgent
        ? await runAgent({ cli, cwd, prompt, args, timeoutMs: RUN_TIMEOUT_MS })
        : await runClaude({ cli, cwd, prompt, args, timeoutMs: RUN_TIMEOUT_MS });
      return parseHeadlessOutput(stdout);
    }
    const { output, costUsd, usage } = await runStructured({
      driver: headlessDriverFor(provider),
      cli,
      cwd,
      prompt,
      timeoutMs: RUN_TIMEOUT_MS,
      input: {
        access: "read-only",
        isolated: true,
        ephemeral: true,
        budgetUsd,
        sessionId: "",
        model,
        effort: effort ?? null,
        defaultBranch: null,
        outputSchema: REVIEW_OUTPUT_SCHEMA,
      },
      schema: ReviewOutput,
      what: "review",
      ...(runAgent ? { runAgent } : {}),
    });
    return { summary: output.summary, findings: output.findings, costUsd, usage };
  };
}

/** Runs one headless review. */
export const runHeadlessReview: RunHeadless = createHeadlessReviewer();
