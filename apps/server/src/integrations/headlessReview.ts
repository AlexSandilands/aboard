import {
  BUILTIN_REVIEW_SKILL_BODY,
  type CliEffort,
  FindingSeverity,
  type ReviewFindingInput,
  type ReviewSkillRef,
} from "@repo/contracts";
import { z } from "zod";
import { parseClaudeOutput, runClaude } from "./claudeCli.ts";

// The board's own reviewer: Claude Code headless (`claude -p`), read-only, with no MCP servers, returning its
// findings as structured output for the board to record. A fallback for rounds no agent runs.

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
          "The task has screenshots, listed under Images in the task text with their file paths. Open each one with the Read tool and look at it: record a finding for any that shows a visual bug, or when the states the change introduced aren't covered.",
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
}

/** Parses `--output-format json` stdout. Throws with the CLI's own message when it didn't produce findings. */
export function parseHeadlessOutput(stdout: string): HeadlessReview {
  const { output, costUsd } = parseClaudeOutput(stdout, ReviewOutput, "review");
  return { summary: output.summary, findings: output.findings, costUsd };
}

export interface HeadlessJob {
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

/** Runs one headless review. */
export const runHeadlessReview: RunHeadless = async ({ cli, cwd, prompt, budgetUsd, model, effort, addDirs }) =>
  parseHeadlessOutput(
    await runClaude({
      cli,
      cwd,
      prompt,
      args: headlessArgs(budgetUsd, model, effort, addDirs),
      timeoutMs: RUN_TIMEOUT_MS,
    }),
  );
