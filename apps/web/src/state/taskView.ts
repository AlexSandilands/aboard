import { useEffect } from "react";
import { api } from "~/lib/api";

/** How often an open panel tells the server it's still open; the server polls the task's PRs every 20 s meanwhile. */
export const TASK_VIEW_INTERVAL_MS = 20_000;

/**
 * While a task's panel is open and visible, and the task has a PR that GitHub is polled for: tells the server on open
 * (it reads the PRs if they're stale) and every 20 s after (it keeps them hot). The new state arrives over SSE.
 */
export function useTaskView(taskId: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const ping = () => {
      if (document.visibilityState === "visible")
        api<void>(`/api/tasks/${encodeURIComponent(taskId)}/view`, { body: {} }).catch(() => {});
    };
    ping();
    const timer = setInterval(ping, TASK_VIEW_INTERVAL_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [taskId, active]);
}
