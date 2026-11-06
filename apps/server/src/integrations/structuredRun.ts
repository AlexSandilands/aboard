import type { z } from "zod";
import { runHeadlessAgent, type AgentArgsInput, type HeadlessDriver, type RunAgent } from "./headlessAgent.ts";
import { withDriverArgs } from "./headlessDrivers.ts";

// One run on a headless driver that answers in a schema: the board reviewer, Ask and issue import, on whichever
// provider their operation resolved to (docs/features/autopilot.md#headless-drivers).

export interface StructuredRun<T> {
  driver: HeadlessDriver;
  /** The provider's CLI path from Settings → Agents → Providers; null looks it up on PATH. */
  cli: string | null;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  /** The run's arguments; its `outputSchema` is what the answer must match. */
  input: AgentArgsInput & { outputSchema: object };
  /** Checks the structured output the CLI returned. */
  schema: z.ZodType<T>;
  /** What the run does, for errors: "review", "import". */
  what: string;
  env?: Record<string, string>;
  runAgent?: RunAgent;
}

export interface StructuredOutcome<T> {
  output: T;
  /** Null when the CLI reports none (every CLI but Claude Code's). */
  costUsd: number | null;
}

/** Runs it and returns its checked output. Throws with the CLI's own message, under its name, when it has none. */
export async function runStructured<T>(job: StructuredRun<T>): Promise<StructuredOutcome<T>> {
  const { driver } = job;
  const run = job.runAgent ?? runHeadlessAgent;
  const stdout = await withDriverArgs(driver, job.input, (args) =>
    run({
      cli: job.cli,
      command: driver.command,
      label: driver.label,
      cwd: job.cwd,
      prompt: job.prompt,
      args,
      timeoutMs: job.timeoutMs,
      ...(job.env ? { env: job.env } : {}),
    }),
  );
  const outcome = driver.parse(stdout, job.input.outputSchema);
  if (!outcome.ok) throw new Error(`${driver.label}'s ${job.what} failed: ${outcome.error ?? "unknown error"}`);
  const output = job.schema.safeParse(outcome.output);
  if (!output.success) throw new Error(`${driver.label}'s result didn't match the expected shape`);
  return { output: output.data, costUsd: outcome.costUsd };
}
