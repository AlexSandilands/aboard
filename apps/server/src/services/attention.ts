import type { TaskSummary } from "@repo/contracts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError } from "../errors.ts";
import type { Core } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";

/** An agent's request for the user to look at a task (docs/features/notifications.md). */
export interface AttentionService {
  /**
   * Flags the task for the user with what to look at, replacing any request already standing, and sends an
   * `agent_request` notification. Throws VALIDATION for an empty message or a task that is done.
   */
  request(taskId: string, message: string, actor: string): TaskSummary;
  /** Takes the standing request off; false when there was none. The user dismissing it and an agent clearing it are the same. */
  clear(taskId: string, actor: string): { cleared: boolean; task: TaskSummary };
}

export function createAttentionService(
  core: Core,
  deps: { task: (id: string) => TaskRecord; summary: (id: string) => TaskSummary; notifications: NotificationsService },
): AttentionService {
  const { repos } = core;

  return {
    request(taskId, message, actor) {
      const text = message.trim();
      if (!text) throw new AppError("VALIDATION", "Say what the user should look at");
      core.write((fx) => {
        const task = deps.task(taskId);
        if (task.status === "done") {
          throw new AppError("VALIDATION", `#${task.number} is done; a finished task doesn't ask for attention`);
        }
        const requestedAt = core.now().toISOString();
        repos.tasks.update({
          ...task,
          attentionRequest: { message: text, actor, requestedAt },
          updatedAt: requestedAt,
        });
        fx.log(taskId, actor, "attention_requested", { message: text });
        fx.task(taskId);
        deps.notifications.notify({
          kind: "agent_request",
          taskId,
          title: `Attention requested on #${task.number}`,
          body: `#${task.number} ${task.title}\n${text}`,
          dedupeKey: `request:${taskId}:${requestedAt}`,
        });
      });
      return deps.summary(taskId);
    },

    clear(taskId, actor) {
      const cleared = core.write((fx) => {
        const task = deps.task(taskId);
        if (!task.attentionRequest) return false;
        repos.tasks.update({ ...task, attentionRequest: null, updatedAt: core.now().toISOString() });
        fx.log(taskId, actor, "attention_cleared", { requestedBy: task.attentionRequest.actor });
        fx.task(taskId);
        return true;
      });
      return { cleared, task: deps.summary(taskId) };
    },
  };
}
