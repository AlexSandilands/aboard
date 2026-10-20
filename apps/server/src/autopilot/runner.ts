import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOPILOT_ACTOR,
  autopilotSessionName,
  BRAND,
  type CliEffort,
  describeRunModel,
  profileCliEffort,
  profileHeadlessModel,
  resolveRunModel,
  type RunModel,
  type TaskSummary,
} from "@repo/contracts";
import { defaultRunGit, type RunGit } from "../integrations/backup.ts";
import { messageOf } from "../integrations/github.ts";
import {
  agentArgs,
  boardMcpConfig,
  parseAgentOutput,
  runHeadlessAgent,
  type RunAgent,
} from "../integrations/headlessAgent.ts";
import { latestThread } from "../integrations/reviewFallbacks.ts";
import {
  isT3Unavailable,
  t3Unavailable,
  type T3Integration,
  type ThreadLink,
  type ThreadWorkspace,
} from "../integrations/t3.ts";
import type { Logger } from "../integrations/util.ts";
import type { Services } from "../services/types.ts";
import { createRepoGate, gateFetches } from "./repoGate.ts";
import { readRunnerOptions, type RunnerOptions } from "./runnerOptions.ts";
import {
  RunAbandonedError,
  WorktreeHeadError,
  type Runner,
  type RunnerRequest,
  type RunnerResult,
  type RunPatch,
} from "./types.ts";
import { createWorktree, defaultBranchOf, removeWorktree, type Worktree } from "./worktrees.ts";

// Carries out Autopilot's agent actions (docs/features/autopilot.md#runners): a new T3 Code thread, a nudge into
// the task's live thread, or `claude -p` in a worktree of its own.

/** The T3 command id of a run's launch or nudge: T3 de-duplicates by it, so a retry never starts a second thread. */
export const runCommandId = (runId: string) => `autopilot-${runId}`;

/**
 * The model a run starts on: the automation's choice (its config's, else the action's own), else what the task's labels
 * or suggested tier pick (resolveRunModel).
 */
export function runModel(
  request: Pick<RunnerRequest, "tier" | "modelChoice">,
  options: RunnerOptions,
  task: Pick<TaskSummary, "labels"> | null,
  settings: Parameters<typeof resolveRunModel>[1],
): RunModel {
  const configured = "from" in options.modelChoice ? null : options.modelChoice;
  const input = { labels: task?.labels ?? [], tier: request.tier };
  const model = resolveRunModel({ ...input, choice: configured ?? request.modelChoice ?? null }, settings);
  // The Model setting names a custom model since deleted: the action's own choice still comes before the task's.
  if (model.note && configured && request.modelChoice) {
    return { ...resolveRunModel({ ...input, choice: request.modelChoice }, settings), note: model.note };
  }
  return model;
}

/**
 * A headless run's `--model` and what to note on the run about it: a model typed in the automation's config wins,
 * then the chosen model's Claude Code model; a chosen model with none runs on the CLI's default, and says so.
 */
export function headlessModel(
  model: RunModel,
  typed: string,
): { model: string | null; effort: CliEffort | null; note: string | null } {
  if (typed.trim()) return { model: typed.trim(), effort: null, note: null };
  const cli = profileHeadlessModel(model.profile);
  const described = describeRunModel(model);
  const lines = [model.note];
  // A model set only for T3 Code is worth a word; one with nothing set is the CLI's default as always.
  if (described && cli) lines.push(`Model: ${described}`);
  else if (described && model.profile?.setting.t3) {
    lines.push(`Model: ${described} has no Claude Code model in Settings → Model tiers, so the CLI's default ran`);
  }
  const note = lines.filter(Boolean).join("\n") || null;
  // Only the Claude Code model has an effort of its own; a T3 model that stood in for it carries none.
  return { model: cli, effort: profileCliEffort(model.profile, "claude-code"), note };
}

/** Whether T3 Code can take a run now: detected, with a token that works. */
const t3Ready = (status: ReturnType<T3Integration["status"]>) => status.detected && status.liveStatus === "ok";

/** How long a run waits for T3 Code to come up (a restart of the board or of T3) before it fails. */
export const T3_HOLD_MS = 10 * 60_000;
/** How often a held run looks at T3 Code again. */
export const T3_RETRY_MS = 15_000;

/**
 * How long a T3 launch holds its repository's gate while T3 prepares the thread's workspace (its worktree starts with
 * a `git fetch`). Past it the gate is released and the run goes on as if the workspace were ready.
 */
export const T3_PREPARE_MS = 3 * 60_000;
/** How often a launch looks at whether T3 has prepared the workspace. */
export const T3_PREPARE_POLL_MS = 2_000;

/** The wait for T3 Code of one start: when it ends, set by the first failure. */
interface Hold {
  deadline?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SAFETY = (defaultBranch: string | null) =>
  `Never force-push, never push to ${defaultBranch ? `\`${defaultBranch}\`` : "the default branch"} and never merge a pull request; ` +
  "fix conflicts with a merge, not a rebase.";

/** Where the agent's pull request goes when it isn't the default branch: an integration epic's branch. */
const prBaseNote = (prBase: string | null | undefined) =>
  prBase
    ? ` Open your pull request against \`${prBase}\`, the epic's integration branch (\`gh pr create --base ${prBase}\`), not the default branch; Autopilot merges it there once it is reviewed and green.`
    : "";

/** What a headless agent is told about where it works and how its work leaves the worktree. */
export function headlessWorkspaceNote(worktree: Worktree, readOnly: boolean, prBase?: string | null): string {
  // The board links this session itself, under the run's name; an agent linking it again would rename it.
  const where = `You are running unattended as ${BRAND.name} Autopilot, in a git worktree made for this run (${worktree.path}) on branch \`${worktree.branch}\`. Autopilot has already linked this session to the task, so don't link it yourself.`;
  if (readOnly) return `${where} Don't edit files, commit or push.`;
  const push =
    worktree.pushTo === worktree.branch
      ? `Commit there and push with \`git push -u origin ${worktree.branch}\`.`
      : `Commit there and push to the pull request's branch with \`git push origin HEAD:${worktree.pushTo}\`.`;
  return `${where} ${push}${prBaseNote(prBase)} ${SAFETY(worktree.defaultBranch)}`;
}

/** The same for a T3 thread, which gets its worktree from T3. */
export function t3WorkspaceNote(branch: string | null, defaultBranch: string | null, prBase?: string | null): string {
  const push = branch
    ? `Your worktree starts from the pull request's branch \`${branch}\`; push your commits to it with \`git push origin HEAD:${branch}\`. `
    : prBase
      ? `Your worktree starts from \`${prBase}\`.${prBaseNote(prBase)} `
      : "";
  return `You were started by ${BRAND.name} Autopilot. ${push}${SAFETY(defaultBranch)}`;
}

export function createAutopilotRunner(deps: {
  services: () => Services;
  t3: Pick<
    T3Integration,
    "status" | "test" | "launchTaskThread" | "sendToThread" | "threadWorkspace" | "retryPreparation"
  >;
  /** Where headless runs' worktrees go, under the board's data dir. */
  worktreesDir: string;
  /** How long a run waits for an unreachable T3 Code before failing, and how often it looks again. */
  t3HoldMs?: number;
  t3RetryMs?: number;
  /** How long a launch holds the gate while T3 prepares the workspace, and how often it looks. */
  t3PrepareMs?: number;
  t3PreparePollMs?: number;
  runGit?: RunGit;
  runAgent?: RunAgent;
  newSessionId?: () => string;
  /** A headless session was just linked to its task, so the board can read its state at once. */
  sessionLinked?: (sessionId: string) => void;
  /** This board's MCP endpoint and API token, for a run that gets only the board's server (`boardTools`). */
  boardMcp?: () => { url: string; token: string | null };
  log?: Logger;
}): Runner {
  // One `git fetch` per repository at a time across T3 launches and headless worktrees. What the user asks for (an epic's
  // branch, a launch from the dialog) doesn't queue behind them: a hold can last minutes.
  const gate = createRepoGate();
  const runGit = gateFetches(deps.runGit ?? defaultRunGit, gate);
  const runAgent = deps.runAgent ?? runHeadlessAgent;
  const newSessionId = deps.newSessionId ?? randomUUID;
  const log = deps.log ?? console;

  const holdMs = deps.t3HoldMs ?? T3_HOLD_MS;
  const retryMs = deps.t3RetryMs ?? T3_RETRY_MS;
  const prepareMs = deps.t3PrepareMs ?? T3_PREPARE_MS;
  const preparePollMs = deps.t3PreparePollMs ?? T3_PREPARE_POLL_MS;

  const taskOf = (taskId: string): TaskSummary => deps.services().tasks.summary(taskId);

  /**
   * Runs a T3 action, trying again while T3 Code can't be reached (the board or T3 has just restarted and is not
   * answering yet), for up to `holdMs`. The run stays running meanwhile, so nothing is flagged for what is usually a
   * minute's wait. Anything else T3 says fails at once; a retry of a launch carries the same command id, so T3 never
   * starts two threads. One `hold` can span several actions, so their waits don't add up: its clock starts at the first
   * failure. `stillWanted` is asked after each wait, since the board may have moved on in ten minutes.
   */
  const whileUnavailable = async <T>(action: () => Promise<T>, hold: Hold, stillWanted?: () => boolean): Promise<T> => {
    for (let waiting = false; ; waiting = true) {
      try {
        return await action();
      } catch (error) {
        hold.deadline ??= Date.now() + holdMs;
        if (!isT3Unavailable(error) || Date.now() + retryMs > hold.deadline) throw error;
        if (!waiting) log.warn(`[autopilot] waiting for T3 Code: ${messageOf(error)}`);
        await sleep(retryMs);
        if (stillWanted && !stillWanted()) throw new RunAbandonedError("it changed while waiting for T3 Code");
      }
    }
  };

  const nudge = async (request: RunnerRequest, task: TaskSummary, update: (patch: RunPatch) => void) => {
    const thread = latestThread(task);
    if (!thread) throw new Error(`#${task.number} has no live T3 Code thread to nudge`);
    update({ runner: "t3", threadUrl: thread.url });
    await whileUnavailable(
      () => deps.t3.sendToThread(thread, request.prompt, runCommandId(request.run.id)),
      {},
      request.stillWanted,
    );
    return { runner: "t3", threadUrl: thread.url, result: null } satisfies RunnerResult;
  };

  /**
   * Waits while T3 prepares a new thread's workspace: the thread once it has a run that is past "preparing", or what
   * was last seen (null when T3 couldn't say) when the wait ran out. After a retry, `before` is the failure that was
   * retried: T3's shell may still show it for a moment, so a failure counts only once the thread has changed since.
   */
  const prepared = async (link: ThreadLink, before?: ThreadWorkspace): Promise<ThreadWorkspace | null> => {
    const deadline = Date.now() + prepareMs;
    let moved = false;
    let last: ThreadWorkspace | null = null;
    for (;;) {
      const workspace = await deps.t3.threadWorkspace(link).catch(() => null);
      if (workspace) last = workspace;
      if (workspace && before) {
        moved ||=
          workspace.runStatus !== "failed" ||
          workspace.updatedAt !== before.updatedAt ||
          workspace.lastError !== before.lastError;
      }
      // No run yet: T3 hasn't started preparing, let alone fetched.
      const ready = workspace && workspace.latestRunId !== null && workspace.runStatus !== "preparing";
      if (ready && (!before || moved)) return workspace;
      if (Date.now() + preparePollMs > deadline) return last;
      await sleep(preparePollMs);
    }
  };

  /**
   * Waits for T3 to prepare the thread's workspace. One that failed (a fetch that lost the race with a fetch the gate
   * doesn't see, say) is prepared again once, in the same thread; a second failure fails the run.
   */
  const settle = async (link: ThreadLink, runId: string): Promise<void> => {
    const first = await prepared(link);
    if (first?.runStatus !== "failed") return;
    const why = (workspace: ThreadWorkspace) => workspace.lastError ?? "its thread failed";
    if (!first.latestRunId) throw new Error(`T3 Code couldn't start the thread: ${why(first)}`);
    log.warn(`[autopilot] preparing the T3 workspace again: ${why(first)}`);
    try {
      await deps.t3.retryPreparation(link, first.latestRunId, `${runCommandId(runId)}-retry`);
    } catch (error) {
      if (isT3Unavailable(error)) throw error;
      // T3 only prepares again a run whose preparation failed: this thread failed for another reason.
      throw new Error(`T3 Code couldn't start the thread: ${why(first)}`, { cause: error });
    }
    const second = await prepared(link, first);
    if (second?.runStatus === "failed") {
      throw new Error(`T3 Code couldn't prepare the thread's workspace: ${why(second)}`);
    }
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
    hold: Hold,
  ): Promise<RunnerResult> => {
    const branch = request.workspace?.branch ?? null;
    const prBase = branch ? null : (request.workspace?.prBase ?? null);
    const project = deps.services().projects.get(task.projectId);
    // T3 Code needs a folder or a T3 project to put the thread in; a folderless lane (General) has neither.
    if (!project.workspaceRoot && !project.t3ProjectId) {
      throw new Error(`${project.title} has neither a workspace folder nor a T3 project to start a thread in`);
    }
    const defaultBranch = await checkBranch(project.workspaceRoot, branch ?? prBase);
    const model = runModel(request, options, task, deps.services().settings.get());
    const described = describeRunModel(model);
    // What the run says about its model, and why T3's default ran instead when the model's T3 model couldn't be used.
    const t3Note = (unavailable: string | null) =>
      [
        model.note,
        described && unavailable ? `Model: ${described}. ${unavailable} T3 Code's default ran.` : null,
        described && !unavailable ? `Model: ${described}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    const before = t3Note(
      model.profile && !model.profile.setting.t3 ? "It has no T3 Code model in Settings → Model tiers." : null,
    );
    if (before) update({ detail: before });
    const launchThread = () =>
      deps.t3.launchTaskThread(
        task.id,
        {
          prompt: `${request.prompt}\n\n${t3WorkspaceNote(branch, defaultBranch, prBase)}`,
          commandId: runCommandId(request.run.id),
          ...(request.label ? { title: autopilotSessionName(request.label) } : {}),
          work: true,
          // The task's labels and tier are read again where the launch resolves its model; only a choice is passed.
          ...(model.source === "automation" && model.profile
            ? { modelChoice: model.profile.tier ? { tier: model.profile.tier } : { profile: model.profile.id } }
            : {}),
          // A pull request's branch is on origin, and origin's copy is the one to build on.
          ...(branch
            ? { baseRef: branch, startFromOrigin: true }
            : prBase
              ? { baseRef: prBase, startFromOrigin: true }
              : request.workspace?.baseRef
                ? { baseRef: request.workspace.baseRef }
                : {}),
          ...(options.t3Access !== "default" ? { maxRuntimeMode: options.t3Access } : {}),
        },
        AUTOPILOT_ACTOR,
      );
    // T3 answers the launch at once and makes the worktree afterwards, starting with a `git fetch` in the project's
    // checkout. Launches in one pass would fetch side by side and all but one fail, so each holds the repository's gate
    // until T3 is past preparing its workspace.
    const launchAndSettle = async () => {
      const launch = await launchThread();
      update({ runner: "t3", threadUrl: launch.link.url });
      // The launch knows best: the model's provider may not be ready, or T3 may no longer offer it.
      if (launch.suggestionUnavailable && described) update({ detail: t3Note(launch.suggestionUnavailable) });
      if (launch.link.kind === "t3_thread") await settle(launch.link, request.run.id);
      return launch;
    };
    const repo = project.workspaceRoot;
    const launch = await whileUnavailable(
      () => (repo ? gate.run(repo, launchAndSettle) : launchAndSettle()),
      hold,
      request.stillWanted,
    );
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
      baseRef: request.workspace?.prBase || request.workspace?.baseRef,
      baseFromOrigin: Boolean(request.workspace?.prBase),
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
        {
          agentSession: { harness: "claude-code", sessionId, cwd: worktree.path },
          label: autopilotSessionName(request.label),
        },
        AUTOPILOT_ACTOR,
      );
      deps.sessionLinked?.(sessionId);
    } catch (error) {
      log.warn(`[autopilot] couldn't link the session of #${task.number}: ${messageOf(error)}`);
    }

    const settings = s.settings.get();
    const chosen = headlessModel(runModel(request, options, task, settings), options.model);
    if (chosen.note) update({ detail: chosen.note });
    const readOnly = request.access === "read-only" || request.access === "none";
    const stdout = await runAgent({
      cli: settings.headlessReviewCli,
      cwd: worktree.path,
      prompt: `${request.prompt}\n\n${headlessWorkspaceNote(worktree, readOnly, request.workspace?.branch ? null : request.workspace?.prBase)}`,
      timeoutMs: options.timeoutMinutes * 60_000,
      args: agentArgs({
        access: request.access ?? "edit",
        budgetUsd: options.budgetUsd,
        sessionId,
        model: chosen.model,
        effort: chosen.effort,
        name: autopilotSessionName(request.label),
        defaultBranch: worktree.defaultBranch,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.deniedTools ? { deniedTools: request.deniedTools } : {}),
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

  /**
   * A run with no task (a digest, a scheduled agent): headless, in an empty folder of its own that is removed
   * afterwards. With a `repo` it can use git there, so it gets the same push guard as a run in a worktree.
   */
  const startDetached = async (request: RunnerRequest, update: (patch: RunPatch) => void): Promise<RunnerResult> => {
    const options = readRunnerOptions(request.options);
    if (request.kind === "nudge") throw new Error("A run with no task has no thread to nudge");
    if (options.runner === "t3") throw new Error("A run with no task can't run in T3 Code");
    const settings = deps.services().settings.get();
    const chosen = headlessModel(runModel(request, options, null, settings), options.model);
    if (chosen.note) update({ detail: chosen.note });
    const defaultBranch = request.repo ? await defaultBranchOf(runGit, request.repo).catch(() => null) : null;
    // A scheduled agent passes `repo` (null when its project has no folder), so it always gets the note.
    const prompt =
      request.repo !== undefined
        ? `${request.prompt}

You are running unattended as ${BRAND.name} Autopilot, with no task and no worktree, in an empty temporary folder. ${SAFETY(defaultBranch)}`
        : request.prompt;
    const cwd = await mkdtemp(join(tmpdir(), `${BRAND.id}-run-`));
    // The board's MCP config carries its token, so it sits outside the folder the agent may read.
    const mcpDir = request.boardTools ? await mkdtemp(join(tmpdir(), `${BRAND.id}-mcp-`)) : null;
    const sessionId = newSessionId();
    update({ runner: "headless", sessionId });
    try {
      let mcpConfig: string | null = null;
      if (mcpDir) {
        if (!request.untrustedInput || request.access !== "read-only") {
          throw new Error("Board tools in a task-less run are only for a read-only run that reads untrusted input");
        }
        const board = deps.boardMcp?.();
        if (!board) throw new Error("The board's MCP endpoint isn't known to the runner");
        mcpConfig = join(mcpDir, "mcp.json");
        await writeFile(mcpConfig, boardMcpConfig(board.url, board.token), { mode: 0o600 });
      }
      const stdout = await runAgent({
        cli: settings.headlessReviewCli,
        cwd,
        prompt,
        timeoutMs: options.timeoutMinutes * 60_000,
        args: agentArgs({
          access: request.access ?? "edit",
          budgetUsd: options.budgetUsd,
          sessionId,
          model: chosen.model,
          effort: chosen.effort,
          name: autopilotSessionName(request.label),
          defaultBranch,
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.deniedTools ? { deniedTools: request.deniedTools } : {}),
          ...(request.untrustedInput ? { untrusted: true } : {}),
          ...(mcpConfig ? { boardMcpConfig: mcpConfig } : {}),
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
      for (const dir of [cwd, mcpDir]) {
        if (!dir) continue;
        await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
          log.warn(`[autopilot] couldn't remove ${dir}: ${messageOf(error)}`);
        });
      }
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
        (request.access ?? "edit") !== "edit" ||
        (request.tools?.length ?? 0) > 0 ||
        (request.deniedTools?.length ?? 0) > 0 ||
        Boolean(request.outputSchema);
      if (headlessOnly) {
        if (options.runner === "t3")
          throw new Error("This action needs a headless run, but the automation runs only in T3 Code");
        return startHeadless(request, task, options, update);
      }
      if (options.runner === "headless") return startHeadless(request, task, options, update);
      // One wait for the whole start: the readiness check and the launch share it.
      const hold: Hold = {};
      // The cached status can be a minute stale, and just after a restart it is empty: look at T3 again before
      // choosing, so a run isn't sent headless (or refused) while T3 is up.
      const lookAtT3 = async () => {
        const status = deps.t3.status();
        return t3Ready(status) ? status : deps.t3.test();
      };
      if (options.runner === "t3") {
        // T3 only: a T3 that isn't there is waited for, a T3 that is there but unusable (no token) is not.
        await whileUnavailable(
          async () => {
            const status = await lookAtT3();
            if (t3Ready(status)) return;
            // Detected but its shell isn't answering: T3 mid-start, or a bad token. The launch tells them apart
            // (an unreachable T3 is waited for there, a refusal fails), so let it go on.
            if (status.detected && status.liveStatus === "error") return;
            const reason = "T3 Code isn't connected, and this automation runs only there";
            throw status.detected ? new Error(reason) : t3Unavailable(reason);
          },
          hold,
          request.stillWanted,
        );
        return startT3(request, task, options, update, hold);
      }
      // Auto never falls back once T3 was asked: the thread may have started even when the reply was lost. A T3 that
      // is not ready after a fresh look is not waited for here: Auto exists for people who don't always run it.
      if (t3Ready(await lookAtT3())) return startT3(request, task, options, update, hold);
      return startHeadless(request, task, options, update);
    },
  };
}
