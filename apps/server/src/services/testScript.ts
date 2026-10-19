import {
  customAgentPrompt,
  customScriptContext,
  customShellEnv,
  customValues,
  parseCheckOutput,
  TEST_OUTPUT_MAX,
  TestScriptInput,
  type CustomAction,
  type CustomValues,
  type Project,
  type TaskSummary,
  type TestScriptResult,
} from "@repo/contracts";
import type { z } from "zod";
import { AppError, notFound } from "../errors.ts";
import { messageOf } from "../integrations/github.ts";
import { InterpreterMissingError, type RunScript } from "../integrations/scriptRunner.ts";

type Draft = z.output<typeof TestScriptInput>;

/**
 * Runs a draft script once from the settings editor (docs/features/autopilot.md#test-runs). It really executes, in the
 * project's folder with the values and stdin a scheduled or task-triggered run would give it, so it can act: nothing
 * about it is a dry run. Nothing is recorded, and one test runs at a time, so a double click can't act twice.
 */
export function createTestScript(deps: {
  runScript: RunScript;
  project: (id: string) => Project | null;
  task: (id: string) => TaskSummary;
  now?: () => number;
}): (input: TestScriptInput) => Promise<TestScriptResult> {
  let running = false;
  const now = deps.now ?? Date.now;

  return async (raw) => {
    const input = TestScriptInput.parse(raw);
    const project = deps.project(input.projectId);
    if (!project) throw notFound("Project", input.projectId);
    if (!project.workspaceRoot) {
      throw new AppError("VALIDATION", `${project.title} has no workspace folder to run the script in`);
    }
    // A check has no task, like the scheduled agent it belongs to; an action may be given one to read its values.
    const task = input.role === "action" && input.taskId ? deps.task(input.taskId) : null;
    const values: CustomValues = {
      ...customValues({ name: input.name }, project, task),
      inputs: input.inputs,
    };
    if (running) throw new AppError("CONFLICT", "A test run is already going: wait for it to finish");
    running = true;
    const started = now();
    const result = (patch: Partial<TestScriptResult>): TestScriptResult => ({
      error: null,
      exitCode: null,
      timedOut: false,
      durationMs: now() - started,
      stdout: "",
      stderr: "",
      truncated: false,
      items: null,
      ...patch,
    });
    try {
      const ran = await deps.runScript({
        language: input.script.language,
        body: input.script.body,
        cwd: project.workspaceRoot,
        env: customShellEnv(values),
        context: customScriptContext(values),
        timeoutMs: input.script.timeoutSeconds * 1000,
      });
      const stdout = ran.stdout.slice(0, TEST_OUTPUT_MAX);
      const stderr = ran.stderr.slice(-TEST_OUTPUT_MAX);
      const items =
        input.role === "check" && !ran.timedOut && ran.exitCode === 0
          ? ran.stdoutTruncated
            ? { problem: "It printed more than the board reads" }
            : checkItems(ran.stdout, input, values)
          : null;
      return result({
        exitCode: ran.exitCode,
        timedOut: ran.timedOut,
        stdout,
        stderr,
        truncated: ran.stdout.length > stdout.length || ran.stdoutTruncated || ran.stderr.length > stderr.length,
        items,
      });
    } catch (error) {
      // A missing interpreter is the user's to fix, so it is an answer, not a server error.
      return result({
        error:
          error instanceof InterpreterMissingError ? `The script couldn't run: ${error.message}` : messageOf(error),
      });
    } finally {
      running = false;
    }
  };
}

/** What a check printed, read as the board reads it, with the prompt its first item would start. */
function checkItems(stdout: string, input: Draft, values: CustomValues): NonNullable<TestScriptResult["items"]> {
  const parsed = parseCheckOutput(stdout);
  if (!parsed.ok) return { problem: parsed.error };
  const first = parsed.items[0];
  if (!first || !input.prompt.trim()) return { items: parsed.items, dropped: parsed.dropped, prompt: null };
  const action = {
    kind: "agent",
    prompt: input.prompt,
    skill: input.skill,
    tier: null,
    onPrBranch: false,
    allowedTools: [],
    inputs: [],
    slots: [],
    check: input.script,
    untrustedItems: true,
  } satisfies CustomAction;
  const prompt = customAgentPrompt({ name: input.name, action }, { ...values, item: first }, null, null);
  return { items: parsed.items, dropped: parsed.dropped, prompt };
}
