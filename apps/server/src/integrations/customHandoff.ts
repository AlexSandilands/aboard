import { randomUUID } from "node:crypto";
import {
  AGENT_HARNESSES,
  customHandoffLabel,
  customHandoffModel,
  customHandoffThreadTitle,
  handoffTargetHarness,
  providerActive,
  providerOfHarness,
  renderCustomHandoffPrompt,
  type AgentHarness,
  type AppSettings,
  type CustomHandoff,
  type SessionLaunchOptions,
  type SessionWorkspace,
  type StartCustomHandoffInput,
  type StartCustomHandoffResult,
  type StartSessionInput,
  type StartSessionResult,
  type TaskBranch,
  type TaskSummary,
} from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { Services } from "../services/types.ts";
import type { TaskThreadInput, TaskThreadLaunch } from "./t3.ts";

// Starting a custom hand-off (Settings → Agents → Custom hand-offs) without its dialog: the saved prompt rendered for
// the task, on the saved model and workspace, as a T3 Code thread or a CLI session. With the dialog, the browser
// sends the same launch the built-in entries do. See docs/features/agent-handoff.md#custom-hand-offs.

export interface CustomHandoffLauncher {
  /** The hand-off with this id, or NOT_FOUND. */
  get(handoffId: string): CustomHandoff;
  start(
    taskId: string,
    handoffId: string,
    input: StartCustomHandoffInput,
    actor: string,
  ): Promise<StartCustomHandoffResult>;
}

/** What one target's launch reports; the rest of the result is the same for both. */
type Started = Pick<StartCustomHandoffResult, "link" | "session" | "workspace" | "branch" | "model" | "note">;

/** The task's first branch that has its own worktree, in picker order (open PRs first), as the dialogs pick it. */
const taskWorktree = (branches: readonly TaskBranch[]): { worktreePath: string; branch: string } | null => {
  const branch = branches.find((b) => b.worktreePath);
  return branch ? { worktreePath: branch.worktreePath!, branch: branch.name } : null;
};

/** Why a hand-off isn't offered on a task, as its menu decides (customHandoffsFor), or null when it is. */
function unavailable(handoff: CustomHandoff, task: TaskSummary, settings: AppSettings): string | null {
  if (task.kind === "epic") return `#${task.number} is an epic: custom hand-offs start on its tasks`;
  if (task.manual)
    return `#${task.number} is a manual task: it is for people to do, so no agent session is started on it`;
  if (task.archivedAt) return `#${task.number} is archived`;
  if (handoff.projectIds && !handoff.projectIds.includes(task.projectId)) {
    return `“${handoff.name}” isn't shown on this task's project (Settings → Agents → Custom hand-offs)`;
  }
  const harness = handoffTargetHarness(handoff.target);
  const label = harness ? AGENT_HARNESSES[harness].label : "T3 Code";
  if (!providerActive(settings, harness ? providerOfHarness(harness) : "t3-code")) {
    return `${label} isn't added and switched on in Settings → Agents → Providers`;
  }
  if (!settings.handoffMenus[handoff.target]) {
    return `${label} is hidden from the hand-off menus in Settings → Agents → Providers`;
  }
  return null;
}

export function createCustomHandoffLauncher(deps: {
  services: () => Pick<Services, "tasks" | "settings">;
  /** The board's origin, when the browser didn't send its own. */
  boardUrl: () => string;
  launchThread: (taskId: string, input: TaskThreadInput, actor: string) => Promise<TaskThreadLaunch>;
  /** The task's branches and their worktrees, for a T3 launch in the task's worktree. */
  taskBranches: (taskId: string) => Promise<TaskBranch[]>;
  sessionOptions: (taskId: string) => Promise<SessionLaunchOptions>;
  startSession: (taskId: string, input: StartSessionInput, actor: string) => Promise<StartSessionResult>;
}): CustomHandoffLauncher {
  const get = (handoffId: string): CustomHandoff => {
    const handoff = deps
      .services()
      .settings.get()
      .customHandoffs.find((h) => h.id === handoffId);
    if (!handoff) throw new AppError("NOT_FOUND", `No custom hand-off with id ${handoffId}`);
    return handoff;
  };

  const startThread = async (
    handoff: CustomHandoff,
    task: TaskSummary,
    prompt: string,
    commandId: string,
    actor: string,
  ): Promise<Started> => {
    // A task with no worktree yet gets a new one, as its dialog would start in.
    const existing =
      handoff.workspace === "task_worktree" ? taskWorktree(await deps.taskBranches(task.id).catch(() => [])) : null;
    const launch = await deps.launchThread(
      task.id,
      {
        prompt,
        commandId,
        title: customHandoffThreadTitle(handoff, task),
        work: true,
        // Like the card's own launch: on finished work the thread is a follow-up, which the board never messages.
        followUp: true,
        ...(handoff.model === "inherit" ? {} : { modelChoice: handoff.model }),
        ...(handoff.workspace === "current" ? { workspace: { mode: "current" as const } } : {}),
        ...(existing ? { workspace: { mode: "existing_worktree" as const, ...existing } } : {}),
        // A new worktree for an integration epic's task starts from origin's copy of the epic's branch.
        ...(task.integrationBranch ? { baseRef: task.integrationBranch, startFromOrigin: true } : {}),
      },
      actor,
    );
    const { workspace } = launch;
    return {
      link: launch.link,
      session: null,
      workspace: workspace.mode === "existing_worktree" ? "task_worktree" : workspace.mode,
      branch:
        workspace.mode === "new_worktree"
          ? workspace.baseRef
          : workspace.mode === "existing_worktree"
            ? workspace.branch
            : null,
      model: launch.modelSelection.model,
      note: launch.suggestionUnavailable,
    };
  };

  const startCli = async (
    handoff: CustomHandoff,
    harness: AgentHarness,
    task: TaskSummary,
    prompt: string,
    actor: string,
  ): Promise<Started> => {
    const options = await deps.sessionOptions(task.id);
    let workspace: SessionWorkspace = { mode: "current" };
    if (handoff.workspace !== "current" && options.isRepo) {
      const existing = handoff.workspace === "task_worktree" ? taskWorktree(options.taskBranches ?? []) : null;
      if (existing) workspace = { mode: "existing_worktree", ...existing };
      else {
        // An integration epic's task starts from the epic's branch (origin's copy first), else the default branch.
        const epic = task.integrationBranch;
        const baseRef =
          (epic &&
            (options.branches.find((b) => b === `origin/${epic}`) ?? options.branches.find((b) => b === epic))) ||
          options.defaultBaseRef;
        if (!baseRef) throw new AppError("VALIDATION", "The project has no branch to start a worktree from");
        workspace = { mode: "new_worktree", baseRef };
      }
    }
    const { cliModel, cliEffort } = customHandoffModel(handoff, task, deps.services().settings.get());
    const session = await deps.startSession(
      task.id,
      {
        harness,
        mode: "work",
        prompt,
        model: cliModel,
        effort: cliEffort,
        workspace,
        label: customHandoffLabel(handoff, task),
      },
      actor,
    );
    return {
      link: null,
      session,
      workspace:
        workspace.mode === "existing_worktree"
          ? "task_worktree"
          : workspace.mode === "new_worktree"
            ? "new_worktree"
            : "current",
      branch: session.branch,
      model: cliModel,
      note: null,
    };
  };

  return {
    get,
    async start(taskId, handoffId, input, actor) {
      const handoff = get(handoffId);
      const settings = deps.services().settings.get();
      const task = deps.services().tasks.summary(taskId);
      const reason = unavailable(handoff, task, settings);
      if (reason) throw new AppError("VALIDATION", reason);
      const prompt = renderCustomHandoffPrompt(handoff, task, input.boardUrl ?? deps.boardUrl());
      const harness = handoffTargetHarness(handoff.target);
      const started = harness
        ? await startCli(handoff, harness, task, prompt, actor)
        : await startThread(handoff, task, prompt, input.commandId ?? randomUUID(), actor);
      return {
        name: handoff.name,
        target: handoff.target,
        prompt,
        ...started,
        fellBack: handoff.workspace === "task_worktree" && started.workspace === "new_worktree",
        // The hand-off's own model with nothing for this target says more than T3's reason for its default.
        note: customHandoffModel(handoff, task, settings).warning ?? started.note,
      };
    },
  };
}
