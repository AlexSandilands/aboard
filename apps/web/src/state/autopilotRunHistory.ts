import type {
  AutomationWeek,
  AutopilotRunFilter,
  AutopilotRunPage,
  DeleteAutopilotRunsInput,
  DeleteAutopilotRunsResult,
} from "@repo/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { runHistoryParams } from "~/components/autopilot/runHistory.logic";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";
import { queryKeys } from "./queries";

/*
 * The run history page's data. Keys sit under `autopilotRuns`, so every autopilot.changed refetches them with the
 * other runs queries: an infinite query refetches page by page, taking each next cursor from the page before, so a run
 * made meanwhile moves the pages along instead of dropping one. Deleting publishes autopilot.changed too, so
 * the mutation doesn't touch the cache.
 */

/** One automation's (or every automation's) runs matching the filter, newest first, a page at a time. */
export function useAutopilotRunHistory(filter: AutopilotRunFilter) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.autopilotRunsAll, "history", filter] as const,
    queryFn: ({ pageParam, signal }) =>
      api<AutopilotRunPage>(`/api/autopilot/runs/history?${runHistoryParams(filter, pageParam)}`, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** What a delete would remove and keep, asked for while its confirm dialog is open (`input` null: not open). */
export function useDeleteRunsPreview(input: Omit<DeleteAutopilotRunsInput, "preview"> | null) {
  return useQuery({
    queryKey: [...queryKeys.autopilotRunsAll, "deletePreview", input] as const,
    queryFn: ({ signal }) =>
      api<DeleteAutopilotRunsResult>("/api/autopilot/runs/delete", { body: { ...input, preview: true }, signal }),
    enabled: input !== null,
    // The answer is only good for the moment the user reads it.
    gcTime: 0,
  });
}

/** Deletes runs by hand, those in `input` that the server doesn't keep; the reply says how many it kept and why. */
export function useDeleteAutopilotRuns() {
  return useMutation({
    mutationFn: (input: Omit<DeleteAutopilotRunsInput, "preview">) =>
      api<DeleteAutopilotRunsResult>("/api/autopilot/runs/delete", { body: input }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't delete the runs",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** An automation's last seven days, for its This week section; refetched with the other runs queries. */
export function useAutomationWeek(automation: string) {
  return useQuery({
    queryKey: [...queryKeys.autopilotRunsAll, "week", automation] as const,
    queryFn: ({ signal }) =>
      api<AutomationWeek>(`/api/autopilot/automations/${encodeURIComponent(automation)}/week`, { signal }),
  });
}

const errorToast = (title: string) => (error: unknown) =>
  toastManager.add({ type: "error", title, description: error instanceof Error ? error.message : String(error) });

/** Hides a tuning hint until its situation changes. The overview refetches on the autopilot.changed it publishes. */
export function useDismissHint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>("/api/autopilot/hints/dismiss", { body: { id } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot }),
    onError: errorToast("Couldn't dismiss the hint"),
  });
}

/** Runs an automation that paused itself in a project again, counting failures from now. */
export function useResumeAutoPause() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { automation: string; projectId: string }) =>
      api<void>("/api/autopilot/auto-pauses/resume", { body: input }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot }),
    onError: errorToast("Couldn't resume the automation"),
  });
}
