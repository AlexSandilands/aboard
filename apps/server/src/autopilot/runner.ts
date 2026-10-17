import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT_ACTOR, BRAND, type ModelTier, type ModelTiers, type TaskSummary } from "@repo/contracts";
import { defaultRunGit, type RunGit } from "../integrations/backup.ts";
import { messageOf } from "../integrations/github.ts";
import { agentArgs, parseAgentOutput, runHeadlessAgent, type RunAgent } from "../integrations/headlessAgent.ts";
import { latestThread } from "../integrations/reviewFallbacks.ts";
import type { T3Integration } from "../integrations/t3.ts";
import type { Logger } from "../integrations/util.ts";
import type { Services } from "../services/types.ts";
import { readRunnerOptions, type RunnerOptions } from "./runnerOptions.ts";
import { WorktreeHeadError, type Runner, type RunnerRequest, type RunnerResult, type RunPatch } from "./types.ts";
import { createWorktree, defaultBranchOf, removeWorktree, type Worktree } from "./worktrees.ts";

// Carries out Autopilot's agent actions (docs/features/autopilot.md#runners): a new T3 Code thread, a nudge into
// the task's live thread, or `claude -p` in a worktree of its own.

/** The T3 command id of a run's launch or nudge: T3 de-duplicates by it, so a retry never starts a second thread. */
export const runCommandId = (runId: string) => `autopilot-${runId}`;

/** What an Autopilot session is called: the run's label behind "Autopilot · ", or just "Autopilot session". */
export const sessionName = (label: string | undefined): string =>
  label?.trim() ? `Autopilot · ${label.trim()}` : "Autopilot session";

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
  // The board links this session itself, under the run's name; an agent linking it again would rename it.
  const where = `You are running unattended as ${BRAND.name} Autopilot, in a git worktree made for this run (${worktree.path}) on branch \`${worktree.branch}\`. Autopilot has already linked this session to the task, so don't link it yourself.`;
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
  /** A headless session was just linked to its task, so the board can read its state at once. */
  sessionLinked?: (sessionId: string) => void;
  log?: Logger;
}): Runner {
  const runGit = deps.runGit ?? defaultRunGit;
  const runAgent = deps.runAgent ?? runHeadlessAgent;
  const newSessionId = deps.newSessionId ?? randomUUID;
  const log = deps.log ?? console;

  const taskOf = (taskId: string): TaskSummary => deps.services().tasks.summary(taskId);

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
        ...(request.label ? { title: sessionName(request.label) } : {}),
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

  /** Throws when the worktree isn't at `expected`, saying whether the branch merely moved ahead of it. */
  const checkHead = async (cwd: string, expected: string): Promise<void> => {
    const head = (await runGit(["rev-parse", "HEAD"], cwd)).stdout.trim();
    if (head === expected) return;
    const moved = (await runGit(["merge-base", "--is-ancestor", expected, head], cwd)).code === 0;
    throw new WorktreeHeadError(
      moved
        ? `The branch moved on: the worktree is at ${head.slice(0, 7)}, past ${expected.slice(0, 7)}`
        : `The worktree is at ${head.slice(0, 7)}, not the PR's head ${expected.slice(0, 7)}: is the branch on origin up to date, and is it the PR's repository?`,
      head,
      moved,
    );
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
      // A reviewer can't push, so it may read the default branch too.
      readOnly: request.access === "read-only",
    });
    // Before the agent costs anything: it must be reading the commit it was asked about.
    if (request.expectHead) {
      try {
        await checkHead(worktree.path, request.expectHead);
      } catch (error) {
        // The run records no worktree yet, so cleanup would never find this one: remove it now, with its branch (the
        // agent never ran, so the branch holds nothing of its own).
        await removeWorktree(runGit, worktree.path).catch(() => null);
        await runGit(["branch", "-D", worktree.branch], project.workspaceRoot).catch(() => null);
        throw error;
      }
    }
    const sessionId = newSessionId();
    update({ runner: "headless", worktreePath: worktree.path, sessionId });
    try {
      // So the card offers "Open in terminal" to resume the session in its worktree.
      s.links.add(
        task.id,
        { agentSession: { harness: "claude-code", sessionId, cwd: worktree.path }, label: sessionName(request.label) },
        AUTOPILOT_ACTOR,
      );
      deps.sessionLinked?.(sessionId);
    } catch (error) {
      log.warn(`[autopilot] couldn't link the session of #${task.number}: ${messageOf(error)}`);
    }

    const settings = s.settings.get();
    const readOnly = request.access === "read-only" || request.access === "none";
    const stdout = await runAgent({
      cli: settings.headlessReviewCli,
      cwd: worktree.path,
      prompt: `${request.prompt}\n\n${headlessWorkspaceNote(worktree, readOnly)}`,
      timeoutMs: options.timeoutMinutes * 60_000,
      args: agentArgs({
        access: request.access ?? "edit",
        budgetUsd: options.budgetUsd,
        sessionId,
        model: options.model.trim() || tierModel(settings.modelTiers, request.tier),
        name: sessionName(request.label),
        defaultBranch: worktree.defaultBranch,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.untrustedInput ? { untrusted: true } : {}),
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

  /** A run with no task (a digest): headless, in an empty folder of its own that is removed afterwards. */
  const startDetached = async (request: RunnerRequest, update: (patch: RunPatch) => void): Promise<RunnerResult> => {
    const options = readRunnerOptions(request.options);
    if (request.kind === "nudge") throw new Error("A run with no task has no thread to nudge");
    if (options.runner === "t3") throw new Error("A run with no task can't run in T3 Code");
    const settings = deps.services().settings.get();
    const cwd = await mkdtemp(join(tmpdir(), `${BRAND.id}-run-`));
    const sessionId = newSessionId();
    update({ runner: "headless", sessionId });
    try {
      const stdout = await runAgent({
        cli: settings.headlessReviewCli,
        cwd,
        prompt: request.prompt,
        timeoutMs: options.timeoutMinutes * 60_000,
        args: agentArgs({
          access: request.access ?? "edit",
          budgetUsd: options.budgetUsd,
          sessionId,
          model: options.model.trim() || tierModel(settings.modelTiers, request.tier),
          name: sessionName(request.label),
          defaultBranch: null,
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
        }),
      });
      const outcome = parseAgentOutput(stdout, Boolean(request.outputSchema));
      if (outcome.costUsd !== null) update({ costUsd: outcome.costUsd });
      if (!outcome.ok) throw new Error(`Claude Code stopped: ${outcome.error ?? "unknown error"}`);
      return {
        runner: "headless",
        sessionId,
        ...(outcome.costUsd !== null ? { costUsd: outcome.costUsd } : {}),
        result: outcome.result,
        ...(request.outputSchema ? { output: outcome.output } : {}),
      };
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => {
        log.warn(`[autopilot] couldn't remove ${cwd}: ${messageOf(error)}`);
      });
    }
  };

  return {
    async start(request, update = () => {}) {
      if (!request.run.taskId) return startDetached(request, update);
      const task = taskOf(request.run.taskId);
      if (request.kind === "nudge") return nudge(request, task, update);
      const options = readRunnerOptions(request.options);
      // A T3 thread can't be held to read-only, given tools or asked for structured output.
      const headlessOnly =
        (request.access ?? "edit") !== "edit" || (request.tools?.length ?? 0) > 0 || Boolean(request.outputSchema);
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
