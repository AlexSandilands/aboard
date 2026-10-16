import { randomUUID } from "node:crypto";
import { AUTOPILOT_ACTOR, BRAND, type ModelTier, type ModelTiers, type TaskSummary } from "@repo/contracts";
import { defaultRunGit, type RunGit } from "../integrations/backup.ts";
import { messageOf } from "../integrations/github.ts";
import { agentArgs, parseAgentOutput, runHeadlessAgent, type RunAgent } from "../integrations/headlessAgent.ts";
import { latestThread } from "../integrations/reviewFallbacks.ts";
import type { T3Integration } from "../integrations/t3.ts";
import type { Logger } from "../integrations/util.ts";
import type { Services } from "../services/types.ts";
import { readRunnerOptions, type RunnerOptions } from "./runnerOptions.ts";
import type { Runner, RunnerRequest, RunnerResult, RunPatch } from "./types.ts";
import { createWorktree, defaultBranchOf, type Worktree } from "./worktrees.ts";

// Carries out Autopilot's agent actions (docs/features/autopilot.md#runners): a new T3 Code thread, a nudge into
// the task's live thread, or `claude -p` in a worktree of its own.

/** The T3 command id of a run's launch or nudge: T3 de-duplicates by it, so a retry never starts a second thread. */
export const runCommandId = (runId: string) => `autopilot-${runId}`;

/** A tier's T3 model, when it is a Claude model `claude --model` can take; null otherwise. */
export function tierModel(tiers: ModelTiers, tier: ModelTier | null): string | null {
  const model = tier ? tiers[tier].t3?.selection.model : null;
  return model && /^(claude-|opus|sonnet|haiku)/i.test(model) ? model : null;
}

/** Whether T3 Code can take a run now: detected, with a token that works. */
const t3Ready = (status: ReturnType<T3Integration["status"]>) => status.detected && status.liveStatus === "ok";

const SAFETY = (defaultBranch: string | null) =>
  `Never force-push, never push to ${defaultBranch ? `\`${defaultBranch}\`` : "the default branch"} and never merge a pull request; ` +
  "fix conflicts with a merge, not a rebase.";

/** What a headless agent is told about where it works and how its work leaves the worktree. */
export function headlessWorkspaceNote(worktree: Worktree, readOnly: boolean): string {
  const where = `You are running unattended as ${BRAND.name} Autopilot, in a git worktree made for this run (${worktree.path}) on branch \`${worktree.branch}\`.`;
  if (readOnly) return `${where} Don't edit files, commit or push.`;
  const push =
    worktree.pushTo === worktree.branch
      ? `Commit there and push with \`git push -u origin ${worktree.branch}\`.`
      : `Commit there and push to the pull request's branch with \`git push origin HEAD:${worktree.pushTo}\`.`;
  return `${where} ${push} ${SAFETY(worktree.defaultBranch)}`;
}

/** The same for a T3 thread, which gets its worktree from T3. */
export function t3WorkspaceNote(branch: string | null, defaultBranch: string | null): string {
  const push = branch
    ? `Your worktree starts from the pull request's branch \`${branch}\`; push your commits to it with \`git push origin HEAD:${branch}\`. `
    : "";
  return `You were started by ${BRAND.name} Autopilot. ${push}${SAFETY(defaultBranch)}`;
}

export function createAutopilotRunner(deps: {
  services: () => Services;
  t3: Pick<T3Integration, "status" | "launchTaskThread" | "sendToThread">;
  /** Where headless runs' worktrees go, under the board's data dir. */
  worktreesDir: string;
  runGit?: RunGit;
  runAgent?: RunAgent;
  newSessionId?: () => string;
  log?: Logger;
}): Runner {
  const runGit = deps.runGit ?? defaultRunGit;
  const runAgent = deps.runAgent ?? runHeadlessAgent;
  const newSessionId = deps.newSessionId ?? randomUUID;
  const log = deps.log ?? console;

  const taskOf = (request: RunnerRequest): TaskSummary => {
    if (!request.run.taskId) throw new Error("An agent run needs a task to work on");
    return deps.services().tasks.summary(request.run.taskId);
  };

  const nudge = async (request: RunnerRequest, task: TaskSummary, update: (patch: RunPatch) => void) => {
    const thread = latestThread(task);
    if (!thread) throw new Error(`#${task.number} has no live T3 Code thread to nudge`);
    update({ runner: "t3", threadUrl: thread.url });
    await deps.t3.sendToThread(thread, request.prompt, runCommandId(request.run.id));
    return { runner: "t3", threadUrl: thread.url, result: null } satisfies RunnerResult;
  };

  /** The default branch, and a refusal when the run was asked to work on it. */
  const checkBranch = async (repo: string | null, branch: string | null | undefined) => {
    const defaultBranch = repo ? await defaultBranchOf(runGit, repo).catch(() => null) : null;
    if (branch && branch === defaultBranch) {
      throw new Error(`Autopilot doesn't work on the default branch (${defaultBranch})`);
    }
    return defaultBranch;
  };

  const startT3 = async (
    request: RunnerRequest,
    task: TaskSummary,
    options: RunnerOptions,
    update: (patch: RunPatch) => void,
  ): Promise<RunnerResult> => {
    const branch = request.workspace?.branch ?? null;
    const project = deps.services().projects.get(task.projectId);
    const defaultBranch = await checkBranch(project.workspaceRoot, branch);
    const launch = await deps.t3.launchTaskThread(
      task.id,
      {
        prompt: `${request.prompt}\n\n${t3WorkspaceNote(branch, defaultBranch)}`,
        commandId: runCommandId(request.run.id),
        work: true,
        // A pull request's branch is on origin, and origin's copy is the one to build on.
        ...(branch
          ? { baseRef: branch, startFromOrigin: true }
          : request.workspace?.baseRef
            ? { baseRef: request.workspace.baseRef }
            : {}),
        ...(options.t3Access !== "default" ? { maxRuntimeMode: options.t3Access } : {}),
      },
      AUTOPILOT_ACTOR,
    );
    update({ runner: "t3", threadUrl: launch.link.url });
    return { runner: "t3", threadUrl: launch.link.url, result: null };
  };

  const startHeadless = async (
    request: RunnerRequest,
    task: TaskSummary,
    options: RunnerOptions,
    update: (patch: RunPatch) => void,
  ): Promise<RunnerResult> => {
    const s = deps.services();
    const project = s.projects.get(task.projectId);
    if (!project.workspaceRoot) throw new Error(`${project.title} has no workspace folder to make a worktree from`);
    const worktree = await createWorktree(runGit, {
      repo: project.workspaceRoot,
      root: deps.worktreesDir,
      taskNumber: task.number,
      runId: request.run.id,
      baseRef: request.workspace?.baseRef,
      branch: request.workspace?.branch,
    });
    const sessionId = newSessionId();
    update({ runner: "headless", worktreePath: worktree.path, sessionId });
    try {
      // So the card offers "Open in terminal" to resume the session in its worktree.
      s.links.add(
        task.id,
        { agentSession: { harness: "claude-code", sessionId, cwd: worktree.path }, label: "Autopilot session" },
        AUTOPILOT_ACTOR,
      );
    } catch (error) {
      log.warn(`[autopilot] couldn't link the session of #${task.number}: ${messageOf(error)}`);
    }

    const settings = s.settings.get();
    const readOnly = request.access === "read-only";
    const stdout = await runAgent({
      cli: settings.headlessReviewCli,
      cwd: worktree.path,
      prompt: `${request.prompt}\n\n${headlessWorkspaceNote(worktree, readOnly)}`,
      timeoutMs: options.timeoutMinutes * 60_000,
      args: agentArgs({
        access: readOnly ? "read-only" : "edit",
        budgetUsd: options.budgetUsd,
        sessionId,
        model: options.model.trim() || tierModel(settings.modelTiers, request.tier),
        defaultBranch: worktree.defaultBranch,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.boardTools === false ? { boardTools: false } : {}),
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      }),
    });
    const outcome = parseAgentOutput(stdout, Boolean(request.outputSchema));
    if (outcome.costUsd !== null) update({ costUsd: outcome.costUsd });
    if (!outcome.ok) throw new Error(`Claude Code stopped: ${outcome.error ?? "unknown error"}`);
    return {
      runner: "headless",
      sessionId,
      worktreePath: worktree.path,
      ...(outcome.costUsd !== null ? { costUsd: outcome.costUsd } : {}),
      result: outcome.result,
      ...(request.outputSchema ? { output: outcome.output } : {}),
    };
  };

  return {
    async start(request, update = () => {}) {
      const task = taskOf(request);
      if (request.kind === "nudge") return nudge(request, task, update);
      const options = readRunnerOptions(request.options);
      // A T3 thread can't be held to read-only, given tools or asked for structured output.
      const headlessOnly =
        request.access === "read-only" || (request.tools?.length ?? 0) > 0 || Boolean(request.outputSchema);
      if (headlessOnly) {
        if (options.runner === "t3")
          throw new Error("This action needs a headless run, but the automation runs only in T3 Code");
        return startHeadless(request, task, options, update);
      }
      const ready = t3Ready(deps.t3.status());
      if (options.runner === "t3" && !ready)
        throw new Error("T3 Code isn't connected, and this automation runs only there");
      // Auto never falls back once T3 was asked: the thread may have started even when the reply was lost.
      if (options.runner === "t3" || (options.runner === "auto" && ready)) {
        return startT3(request, task, options, update);
      }
      return startHeadless(request, task, options, update);
    },
  };
}
