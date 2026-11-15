import { join } from "node:path";
import {
  BRAND,
  MachineSessionRequest,
  MachineT3Request,
  StartT3ThreadInput,
  taskLabel,
  taskNumberValue,
  type MachineSessionResult,
} from "@repo/contracts";
import { createWorktree } from "../../autopilot/worktrees.ts";
import { AppError } from "../../errors.ts";
import type { Services } from "../../services/types.ts";
import type { RunGit } from "../backup.ts";
import type { T3Integration, TaskThreadInput } from "../t3.ts";
import { messageOf } from "../util.ts";

// Interactive work a board starts on a task this runner holds (docs/features/remote-machines.md#interactive-work):
// threads in this machine's own T3 Code, and the folder and link of a CLI session the board then opens over SSH.
// Both answer at once, unlike a job: the board's dialog is waiting.

export interface RunnerInteractive {
  t3(request: unknown): Promise<unknown>;
  session(request: unknown): Promise<MachineSessionResult>;
}

/** The branch prefix of a session's worktree, as on a board (integrations/sessionLaunch.ts). */
const SESSION_BRANCH_PREFIX = `${BRAND.id}/`;

export function createRunnerInteractive(deps: {
  services: () => Services;
  t3: Pick<T3Integration, "launchOptions" | "startThread" | "launchTaskThread" | "sendToThread">;
  runGit: RunGit;
  /** Where this runner keeps worktrees; sessions' go in its `sessions` folder, as on a board. */
  worktreesDir: string;
  /** This machine, as a link made here names it. */
  machine: () => { id: string; name: string };
}): RunnerInteractive {
  /** The task, checked to be one this machine holds: anything else is the board's to act on. */
  const held = (taskId: string) => {
    const s = deps.services();
    if (s.workingCopies.role(taskId) !== "held") {
      let label = "That task";
      try {
        label = taskLabel(s.tasks.summary(taskId));
      } catch {
        // Not a task this machine has at all.
      }
      throw new AppError("CONFLICT", `${label} isn't held by this machine`);
    }
    return s.tasks.summary(taskId);
  };

  return {
    async t3(raw) {
      const request = MachineT3Request.parse(raw);
      held(request.taskId);
      switch (request.op) {
        case "options":
          return deps.t3.launchOptions(request.taskId, request.choice);
        case "start":
          return deps.t3.startThread(request.taskId, StartT3ThreadInput.parse(request.input), request.actor);
        case "launch":
          // The board built the input from its own settings and the hand-off; this machine only carries it out.
          return deps.t3.launchTaskThread(request.taskId, request.input as TaskThreadInput, request.actor);
        case "message": {
          const link = deps.services().links.get(request.linkId);
          if (link.kind !== "t3_thread" || link.taskId !== request.taskId) {
            throw new AppError("NOT_FOUND", "That thread isn't linked to this task");
          }
          await deps.t3.sendToThread(link, request.text, request.commandId);
          return { sent: true };
        }
      }
    },

    async session(raw) {
      const request = MachineSessionRequest.parse(raw);
      const task = held(request.taskId);
      const s = deps.services();
      const project = s.projects.get(task.projectId);
      const root = project.workspaceRoot;
      if (!root) throw new AppError("VALIDATION", `${project.title} has no repository on this machine`);
      let cwd = root;
      let branch: string | null = null;
      if (request.workspace.mode === "new_worktree") {
        // The board names a branch as its own checkout has it; this machine builds on origin's copy, after a fetch.
        const baseRef = request.workspace.baseRef?.replace(/^origin\//, "") ?? null;
        try {
          const worktree = await createWorktree(deps.runGit, {
            repo: root,
            root: join(deps.worktreesDir, "sessions"),
            taskNumber: taskNumberValue(task),
            runId: request.sessionId ?? crypto.randomUUID(),
            ...(baseRef ? { baseRef, baseFromOrigin: true } : {}),
            branchPrefix: SESSION_BRANCH_PREFIX,
          });
          cwd = worktree.path;
          branch = worktree.branch;
        } catch (error) {
          throw new AppError("VALIDATION", `Couldn't make the worktree on ${deps.machine().name}: ${messageOf(error)}`);
        }
      }
      // Linked here, on this machine's copy, so the link says where the session's files are; the board gets it
      // through the change log. A CLI that picks its own id links itself, as on a board.
      const linkId = request.sessionId
        ? s.links.add(
            task.id,
            {
              agentSession: { harness: request.harness, sessionId: request.sessionId, cwd, machine: deps.machine() },
              label: request.label,
            },
            request.actor,
          ).id
        : null;
      return { cwd, branch, linkId };
    },
  };
}
