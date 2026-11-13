import {
  ATTENTION_AUTOPILOT_KEY,
  ATTENTION_REQUEST_KEY,
  type AttentionReason,
  type TaskSummary,
} from "@repo/contracts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
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
  /**
   * The user dismissing one flag, named by its reason's key. It stays hidden while the state that raised it stands
   * and comes back when that changes. An agent's request is cleared and an Autopilot flag dismisses its runs, as
   * their own actions do; those two can't be restored. Dismissing a flag already dismissed does nothing; throws
   * CONFLICT for a key the task isn't flagged for.
   */
  dismiss(taskId: string, key: string, actor: string): TaskSummary;
  /** Dismisses every flag standing on the task. Does nothing when there are none. */
  dismissAll(taskId: string, actor: string): TaskSummary;
  /** Shows a dismissed flag again; one that isn't dismissed (any more) is left as it is. */
  restore(taskId: string, key: string, actor: string): TaskSummary;
  /** Shows every dismissed flag of the task again. */
  restoreAll(taskId: string, actor: string): TaskSummary;
}

export function createAttentionService(
  core: Core,
  deps: { task: (id: string) => TaskRecord; summary: (id: string) => TaskSummary; notifications: NotificationsService },
): AttentionService {
  const { repos } = core;

  const clearRequest = (fx: Effects, task: TaskRecord, actor: string): boolean => {
    if (!task.attentionRequest) return false;
    repos.tasks.update({ ...task, attentionRequest: null, updatedAt: core.now().toISOString() });
    fx.log(task.id, actor, "attention_cleared", { requestedBy: task.attentionRequest.actor });
    fx.task(task.id);
    deps.notifications.resolve({ taskId: task.id, kind: "agent_request" });
    return true;
  };

  /** Marks read the notifications that told the user about what `reason` reports: dismissing it answers them too. */
  const resolveNotifications = (summary: TaskSummary, reason: AttentionReason): void => {
    const [scope, linkId, which] = reason.key.split(":");
    if (scope === "pr" && linkId) {
      if (which === "checks") deps.notifications.resolve({ keyPrefix: `checks:${linkId}:` });
      if (which === "changes") deps.notifications.resolve({ keyPrefix: `changes:${linkId}:` });
    } else if (scope === "link" && linkId) {
      const link = summary.links.find((l) => l.id === linkId);
      if (link?.kind === "t3_thread") {
        deps.notifications.resolve({ keyPrefix: `thread:${link.ref.environmentId}:${link.ref.threadId}:` });
        deps.notifications.resolve({ keyPrefix: `waiting:${linkId}:` });
      }
    } else if (reason.key === "review") {
      deps.notifications.resolve({ taskId: summary.id, kind: "review_finished" });
    } else if (reason.key === ATTENTION_AUTOPILOT_KEY) {
      deps.notifications.resolve({ taskId: summary.id, kind: "autopilot_failed" });
    }
  };

  const dismissReasons = (taskId: string, keys: readonly string[] | "all", actor: string): TaskSummary => {
    const summary = deps.summary(taskId);
    const reasons =
      keys === "all"
        ? summary.attention
        : keys.map((key) => {
            const reason = summary.attention.find((r) => r.key === key);
            if (reason) return reason;
            // A second tab or a double click: it is already hidden.
            if (summary.dismissedAttention.some((r) => r.key === key)) return null;
            throw new AppError(
              "CONFLICT",
              `#${summary.number} has no such flag (any more), so there is nothing to dismiss`,
            );
          });
    const standing = reasons.filter((r): r is AttentionReason => r !== null);
    if (standing.length === 0) return summary;
    core.write((fx) => {
      const at = core.now().toISOString();
      const hidden: string[] = [];
      for (const reason of standing) {
        if (reason.key === ATTENTION_REQUEST_KEY) {
          clearRequest(fx, deps.task(taskId), actor);
          continue;
        }
        if (reason.key === ATTENTION_AUTOPILOT_KEY) {
          repos.autopilotRuns.dismissFlagged(taskId, at);
          fx.autopilot();
        } else {
          repos.attentionDismissals.put(taskId, {
            key: reason.key,
            fingerprint: reason.fingerprint,
            actor,
            dismissedAt: at,
          });
        }
        resolveNotifications(summary, reason);
        hidden.push(reason.message);
      }
      if (hidden.length > 0) fx.log(taskId, actor, "attention_dismissed", { flags: hidden });
      fx.task(taskId);
    });
    return deps.summary(taskId);
  };

  const restoreReasons = (taskId: string, keys: readonly string[] | "all", actor: string): TaskSummary => {
    const summary = deps.summary(taskId);
    const dismissed = summary.dismissedAttention.filter((r) => keys === "all" || keys.includes(r.key));
    if (dismissed.length === 0) return summary;
    core.write((fx) => {
      for (const reason of dismissed) repos.attentionDismissals.remove(taskId, reason.key);
      fx.log(taskId, actor, "attention_restored", { flags: dismissed.map((r) => r.message) });
      fx.task(taskId);
    });
    return deps.summary(taskId);
  };

  return {
    dismiss: (taskId, key, actor) => dismissReasons(taskId, [key], actor),
    dismissAll: (taskId, actor) => dismissReasons(taskId, "all", actor),
    restore: (taskId, key, actor) => restoreReasons(taskId, [key], actor),
    restoreAll: (taskId, actor) => restoreReasons(taskId, "all", actor),

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
      const cleared = core.write((fx) => clearRequest(fx, deps.task(taskId), actor));
      return { cleared, task: deps.summary(taskId) };
    },
  };
}
