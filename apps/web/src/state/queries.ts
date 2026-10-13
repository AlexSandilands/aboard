import type { AppSettings, BoardEvent, BoardSnapshot, FsBrowseResult, IntegrationsStatus, T3ProjectCandidate, TaskDetail } from "@taskboard/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "~/lib/api";
import { applyBoardEvent } from "./boardReducer";

export const queryKeys = {
  board: ["board"] as const,
  task: (id: string) => ["task", id] as const,
  settings: ["settings"] as const,
  integrations: ["integrations"] as const,
  t3Projects: ["t3Projects"] as const,
  fsBrowse: (path: string) => ["fsBrowse", path] as const,
};

/** The whole board: projects, task summaries and T3 status. Kept live by useBoardEvents. */
export function useBoard() {
  return useQuery({ queryKey: queryKeys.board, queryFn: ({ signal }) => api<BoardSnapshot>("/api/board", { signal }) });
}

/** Full task detail (plan, events). Invalidated by task.* events for that task. */
export function useTaskDetail(taskId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.task(taskId ?? ""),
    queryFn: ({ signal }) => api<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId!)}`, { signal }),
    enabled: !!taskId,
  });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: ({ signal }) => api<AppSettings>("/api/settings", { signal }) });
}

export function useIntegrationsStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.integrations,
    queryFn: ({ signal }) => api<IntegrationsStatus>("/api/integrations/status", { signal }),
    enabled,
    staleTime: 30_000,
  });
}

export function useT3ProjectCandidates(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.t3Projects,
    queryFn: ({ signal }) => api<T3ProjectCandidate[]>("/api/integrations/t3/projects", { signal }),
    enabled,
    staleTime: 0,
  });
}

/** Directory listing for the add-project folder browser. Empty path = home directory. */
export function useFsBrowse(path: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.fsBrowse(path),
    queryFn: ({ signal }) => api<FsBrowseResult>(`/api/fs/browse?path=${encodeURIComponent(path)}`, { signal }),
    enabled,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * Subscribes to /events and patches the query cache. Mount once at the app root.
 * On (re)connect the board is refetched, so missed events are never a problem.
 */
export function useBoardEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const source = new EventSource("/events");
    let connectedOnce = false;
    source.addEventListener("ready", () => {
      if (connectedOnce) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.board });
        void queryClient.invalidateQueries({ queryKey: ["task"] });
      }
      connectedOnce = true;
    });
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as BoardEvent;
      queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (board) => (board ? applyBoardEvent(board, event) : board));
      if (event.type === "task.upserted" || event.type === "task.detail_changed") {
        const id = event.type === "task.upserted" ? event.task.id : event.taskId;
        void queryClient.invalidateQueries({ queryKey: queryKeys.task(id) });
      }
      if (event.type === "integrations.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
      }
    };
    return () => source.close();
  }, [queryClient]);
}
