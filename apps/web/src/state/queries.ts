import type {
  AppSettings,
  BackupStatus,
  BoardEvent,
  AutopilotOverview,
  BoardSnapshot,
  FsBrowseResult,
  IntegrationsStatus,
  NotificationList,
  SkillInfo,
  T3LaunchOptions,
  T3ModelCatalog,
  T3ProjectCandidate,
  TaskDetail,
  TaskSummary,
  TaskTemplate,
} from "@repo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { deliverNotification } from "~/components/notifications/delivery";
import { withCreated } from "~/components/notifications/notifications.logic";
import { api, eventsUrl } from "~/lib/api";
import { applyBoardEvent } from "./boardReducer";

export const queryKeys = {
  board: ["board"] as const,
  archivedTasks: ["archivedTasks"] as const,
  task: (id: string) => ["task", id] as const,
  settings: ["settings"] as const,
  integrations: ["integrations"] as const,
  backupStatus: ["backupStatus"] as const,
  notifications: ["notifications"] as const,
  autopilotOverview: ["autopilot", "overview"] as const,
  t3Projects: ["t3Projects"] as const,
  fsBrowse: (path: string) => ["fsBrowse", path] as const,
  t3LaunchOptions: (taskId: string) => ["t3LaunchOptions", taskId] as const,
  projectT3LaunchOptions: (projectId: string) => ["projectT3LaunchOptions", projectId] as const,
  t3Models: ["t3Models"] as const,
  skills: (projectId: string | null) => ["skills", projectId] as const,
  templates: ["templates"] as const,
};

/** Skills on disk a reviewer can follow: the user's, plus the project's when given. Re-read when a picker opens. */
export function useSkills(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.skills(projectId),
    queryFn: ({ signal }) =>
      api<SkillInfo[]>(`/api/skills${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { signal }),
    enabled,
    staleTime: 0,
  });
}

/** The whole board: projects, task summaries and T3 status. Kept live by useBoardEvents. */
export function useBoard() {
  return useQuery({ queryKey: queryKeys.board, queryFn: ({ signal }) => api<BoardSnapshot>("/api/board", { signal }) });
}

/**
 * Archived tasks, which the board snapshot leaves out. Only fetched while "Show archived" is on;
 * invalidated by every task.upserted (a task may have just been archived or unarchived).
 */
export function useArchivedTasks(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.archivedTasks,
    queryFn: async ({ signal }) =>
      (await api<TaskSummary[]>("/api/tasks?includeArchived=true", { signal })).filter((t) => t.archivedAt),
    enabled,
  });
}

/** Full task detail (plan, events). Invalidated by task.detail_changed for that task. */
export function useTaskDetail(taskId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.task(taskId ?? ""),
    queryFn: ({ signal }) => api<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId!)}`, { signal }),
    enabled: !!taskId,
  });
}

/** Every task template, board-wide and per project. Changed only from the UI, so mutations refetch it. */
export function useTemplates() {
  return useQuery({
    queryKey: queryKeys.templates,
    queryFn: ({ signal }) => api<TaskTemplate[]>("/api/templates", { signal }),
    // No SSE event covers templates, so refetch whenever a picker or Settings mounts.
    staleTime: 0,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) => api<AppSettings>("/api/settings", { signal }),
  });
}

/** Autopilot's engine settings and catalogue. */
export function useAutopilotOverview() {
  return useQuery({
    queryKey: queryKeys.autopilotOverview,
    queryFn: ({ signal }) => api<AutopilotOverview>("/api/autopilot", { signal }),
    staleTime: 0,
  });
}

/** The attention inbox, newest first, with the unread count. Kept live by useBoardEvents. */
export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ signal }) => api<NotificationList>("/api/notifications", { signal }),
  });
}

export function useIntegrationsStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.integrations,
    queryFn: ({ signal }) => api<IntegrationsStatus>("/api/integrations/status", { signal }),
    enabled,
    staleTime: 30_000,
  });
}

/** The last git backup run. Polled while shown, quickly while a run is in progress. */
export function useBackupStatus() {
  return useQuery({
    queryKey: queryKeys.backupStatus,
    queryFn: ({ signal }) => api<BackupStatus>("/api/backup/status", { signal }),
    refetchInterval: (query) => (query.state.data?.running ? 1000 : 15_000),
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

/** Models, refs and defaults for starting a T3 Code thread. Fetched fresh each time the dialog opens. */
export function useT3LaunchOptions(taskId: string | null) {
  return useQuery({
    queryKey: queryKeys.t3LaunchOptions(taskId ?? ""),
    queryFn: ({ signal }) =>
      api<T3LaunchOptions>(`/api/tasks/${encodeURIComponent(taskId!)}/t3-launch-options`, { signal }),
    enabled: !!taskId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** The same for a thread about a whole project (Suggest epics). */
export function useProjectT3LaunchOptions(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.projectT3LaunchOptions(projectId ?? ""),
    queryFn: ({ signal }) =>
      api<T3LaunchOptions>(`/api/projects/${encodeURIComponent(projectId!)}/t3-launch-options`, { signal }),
    enabled: !!projectId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** T3 Code's providers and models, for choosing each model tier's T3 model in settings. */
export function useT3ModelCatalog(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.t3Models,
    queryFn: ({ signal }) => api<T3ModelCatalog>("/api/integrations/t3/models", { signal }),
    enabled,
    staleTime: 0,
    retry: false,
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

/** Delay before reopening a stream the browser gave up on; doubles per failure up to the cap. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

/**
 * Subscribes to /events and patches the query cache. Mount once at the app root.
 * On (re)connect the board is refetched, so missed events are never a problem.
 */
export function useBoardEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let connectedOnce = false;

    const onReady = () => {
      failures = 0;
      if (connectedOnce) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.board });
        void queryClient.invalidateQueries({ queryKey: queryKeys.archivedTasks });
        void queryClient.invalidateQueries({ queryKey: ["task"] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      }
      connectedOnce = true;
    };
    const onMessage = (message: MessageEvent) => {
      const event = JSON.parse(message.data as string) as BoardEvent;
      queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (board) =>
        board ? applyBoardEvent(board, event) : board,
      );
      // The server pairs every task.upserted with a task.detail_changed, so detail only listens to the latter.
      if (event.type === "task.detail_changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.task(event.taskId) });
      }
      // Reset rather than invalidate: a failed refetch keeps stale data, and an open panel should show not found.
      if (event.type === "task.deleted") {
        void queryClient.resetQueries({ queryKey: queryKeys.task(event.taskId) });
        // Its notifications went with it, read or not.
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      }
      // Inactive (Show archived off) queries are only marked stale, not refetched.
      if (event.type === "task.upserted" || event.type === "task.deleted") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.archivedTasks });
      }
      if (event.type === "notification.created") {
        if (queryClient.getQueryData(queryKeys.notifications)) {
          queryClient.setQueryData<NotificationList>(queryKeys.notifications, (list) =>
            list ? withCreated(list, event.notification, event.unread) : list,
          );
        } else {
          void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
        }
        deliverNotification(event.notification, event.popup);
      }
      // Read elsewhere (another window, the REST API), or removed with their task.
      if (event.type === "notifications.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      }
      if (event.type === "integrations.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.integrations });
      }
    };
    // EventSource retries a dropped connection itself, but an error response (e.g. Vite's proxy while
    // the dev server restarts) closes it for good, leaving the board silently stale. Reopen it then.
    const onError = () => {
      if (source?.readyState !== EventSource.CLOSED) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** failures, RECONNECT_MAX_MS);
      failures += 1;
      retryTimer = setTimeout(connect, delay);
    };
    const connect = () => {
      source = new EventSource(eventsUrl());
      source.addEventListener("ready", onReady);
      source.addEventListener("message", onMessage);
      source.addEventListener("error", onError);
    };

    connect();
    return () => {
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [queryClient]);
}
