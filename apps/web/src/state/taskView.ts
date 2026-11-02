import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "~/lib/api";
import { queryKeys } from "./queries";

/** How often an open panel tells the server it's still open; the server polls the task's PRs every 20 s meanwhile. */
export const TASK_VIEW_INTERVAL_MS = 20_000;
/** Past the panel's slide (450 ms by default, at most 1.2 s), so the first ping's refetch doesn't land in it. */
const FIRST_PING_DELAY_MS = 1_000;

/**
 * While a task's panel is open and visible, and the task has a PR that GitHub is polled for: tells the server about a second after
 * opening (it reads the PRs if they're stale) and every 20 s after (it keeps them hot). The new state arrives over SSE, and the task is refetched after each ping for the read time.
 */
export function useTaskView(taskId: string, active: boolean): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!active) return;
    const ping = () => {
      if (document.visibilityState !== "visible") return;
      api<void>(`/api/tasks/${encodeURIComponent(taskId)}/view`, { body: {} })
        // A PR that was read but hasn't changed sends no event; refetch so "checked Ns ago" counts from this read.
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }))
        .catch(() => {});
    };
    // Not at once: its refetch re-renders the panel, which would land in the middle of the panel's slide.
    const first = setTimeout(ping, FIRST_PING_DELAY_MS);
    const timer = setInterval(ping, TASK_VIEW_INTERVAL_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [taskId, active, queryClient]);
}
