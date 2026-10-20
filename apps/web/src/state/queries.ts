import type {
  AgentClis,
  AgentIntegrations,
  AgentModels,
  AppSettings,
  AutopilotOverview,
  AutopilotActiveRun,
  AutopilotRun,
  AutopilotScopeEntry,
  AutopilotStatus,
  OrchestrateState,
  BackupStatus,
  BoardEvent,
  BoardSnapshot,
  FsBrowseResult,
  IntegrationsStatus,
  PrFixInfo,
  SettingsAskStatus,
  NotificationList,
  SkillInfo,
  SkillSyncStatus,
  SocialFeed,
  StatsPeriod,
  StatsResponse,
  SessionLaunchOptions,
  T3LaunchOptions,
  T3ModelCatalog,
  T3ProjectCandidate,
  TaskDetail,
  TaskSummary,
  TerminalInfo,
  TaskTemplate,
} from "@repo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { taskActiveRun } from "~/components/autopilot/autopilot.logic";
import { projectHasOrchestrateWork } from "~/components/autopilot/orchestrate.logic";
import { deliverNotification } from "~/components/notifications/delivery";
import { withCreated } from "~/components/notifications/notifications.logic";
import { ApiError, api, eventsUrl } from "~/lib/api";
import { applyBoardEvent } from "./boardReducer";

export const queryKeys = {
  board: ["board"] as const,
  archivedTasks: ["archivedTasks"] as const,
  task: (id: string) => ["task", id] as const,
  settings: ["settings"] as const,
  integrations: ["integrations"] as const,
  /** Whether the settings Ask can run, per Claude Code CLI setting: changing the path asks again. */
  settingsAsk: (cli: string | null) => ["settingsAsk", cli] as const,
  backupStatus: ["backupStatus"] as const,
  skillSync: ["skillSync"] as const,
  notifications: ["notifications"] as const,
  socialFeed: ["socialFeed"] as const,
  stats: (weeks: StatsPeriod, projectId: string | null) => ["stats", weeks, projectId] as const,
  t3Projects: ["t3Projects"] as const,
  fsBrowse: (path: string) => ["fsBrowse", path] as const,
  t3LaunchOptions: (taskId: string) => ["t3LaunchOptions", taskId] as const,
  projectT3LaunchOptions: (projectId: string) => ["projectT3LaunchOptions", projectId] as const,
  t3Models: ["t3Models"] as const,
  skills: (projectId: string | null) => ["skills", projectId] as const,
  autopilot: ["autopilot"] as const,
  /** Every scope's query, for invalidation. */
  autopilotScopeAll: ["autopilotScope"] as const,
  /** The board scope when `projectId` is null. */
  autopilotScope: (projectId: string | null) => ["autopilotScope", projectId] as const,
  /** An epic's scope, under its project's. */
  autopilotEpicScope: (projectId: string, epicId: string) => ["autopilotScope", projectId, epicId] as const,
  /** Every runs query, for invalidation. */
  autopilotRunsAll: ["autopilotRuns"] as const,
  autopilotOrchestrateAll: ["autopilotOrchestrate"] as const,
  autopilotOrchestrate: (projectId: string) => ["autopilotOrchestrate", projectId] as const,
  autopilotRuns: (scope: AutopilotRunsScope) => ["autopilotRuns", scope] as const,
  terminal: ["terminal"] as const,
  agentClis: ["agentClis"] as const,
  agentIntegrations: ["agentIntegrations"] as const,
  agentModels: ["agentModels"] as const,
  sessionLaunchOptions: (taskId: string) => ["sessionLaunchOptions", taskId] as const,
  prFix: (linkId: string) => ["prFix", linkId] as const,
  templates: ["templates"] as const,
  /** Prefix of every project's recurring rules query. */
  recurring: ["recurring"] as const,
  recurringRules: (projectId: string) => ["recurring", projectId] as const,
  customAutomations: ["customAutomations"] as const,
  digests: ["digests"] as const,
  suggestions: ["suggestions"] as const,
};

export type AutopilotRunsScope = { taskId: string } | { projectId: string };

/** Pause, engine limits and the automation catalogue. Re-read when a settings page or popover opens. */
export function useAutopilotOverview(enabled = true) {
  return useQuery({
    queryKey: queryKeys.autopilot,
    queryFn: ({ signal }) => api<AutopilotOverview>("/api/autopilot", { signal }),
    enabled,
    staleTime: 30_000,
  });
}

/** Every automation as seen from the board (`projectId` null) or one project: its own switch and what it resolves to. */
export function useAutopilotScope(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.autopilotScope(projectId),
    queryFn: ({ signal }) =>
      api<AutopilotScopeEntry[]>(
        projectId ? `/api/autopilot/projects/${encodeURIComponent(projectId)}` : "/api/autopilot/board",
        { signal },
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** Every automation as seen from an epic: its own switch and what it resolves to through its project and the board. */
export function useAutopilotEpicScope(projectId: string, epicId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.autopilotEpicScope(projectId, epicId),
    queryFn: ({ signal }) =>
      api<AutopilotScopeEntry[]>(
        `/api/autopilot/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}`,
        { signal },
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** A task's or project's runs, newest first. Invalidated by every autopilot.changed. */
export function useAutopilotRuns(scope: AutopilotRunsScope | null) {
  return useQuery({
    queryKey: queryKeys.autopilotRuns(scope ?? { taskId: "" }),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams(scope ?? {});
      return api<AutopilotRun[]>(`/api/autopilot/runs?${query}`, { signal });
    },
    enabled: !!scope,
  });
}

/**
 * Orchestrate in one project, for its section of the lane popover. Refetched on autopilot.changed and on task changes
 * (they decide whether it is idle) while open, and once a minute for what moves with the clock (quiet hours, caps).
 */
export function useOrchestrateState(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.autopilotOrchestrate(projectId),
    queryFn: ({ signal }) =>
      api<OrchestrateState>(`/api/autopilot/orchestrate/${encodeURIComponent(projectId)}`, { signal }),
    enabled,
    refetchInterval: 60_000,
  });
}

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
  return useQuery(boardQuery);
}

const boardQuery = {
  queryKey: queryKeys.board,
  queryFn: ({ signal }: { signal: AbortSignal }) => api<BoardSnapshot>("/api/board", { signal }),
};

/** Pause and the runs in flight, from the board snapshot; re-renders only when they change. */
export function useAutopilotStatus(): AutopilotStatus | undefined {
  return useQuery({ ...boardQuery, select: (board) => board.autopilot }).data;
}

/** Whether the project has a task Orchestrate would look at, for the lane pill's timer. */
export function useProjectHasOrchestrateWork(projectId: string): boolean {
  return (
    useQuery({ ...boardQuery, select: (board) => projectHasOrchestrateWork(board.tasks, projectId) }).data ?? false
  );
}

/** The run in flight on a task, for its card badge. The reducer keeps run objects stable between events. */
export function useTaskActiveRun(taskId: string): AutopilotActiveRun | undefined {
  return useQuery({ ...boardQuery, select: (board) => taskActiveRun(board.autopilot, taskId) }).data;
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

/** Whether the settings Ask can run: the Claude Code CLI is found. `cli` is the setting, so a new path is checked again. */
export function useSettingsAskStatus(cli: string | null) {
  return useQuery({
    queryKey: queryKeys.settingsAsk(cli),
    queryFn: ({ signal }) => api<SettingsAskStatus>("/api/settings/ask", { signal }),
    // A cheap local check, and the answer changes when the user installs the CLI: look again when the page opens.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
}

/** What "Open in terminal" runs here. Read again whenever settings change it, as its preview follows the setting. */
export function useTerminalInfo(enabled = true) {
  return useQuery({
    queryKey: queryKeys.terminal,
    queryFn: ({ signal }) => api<TerminalInfo>("/api/terminal", { signal }),
    enabled,
  });
}

/**
 * Whether the board can start Claude Code and Copilot CLI here, for the hand-off menu's "New … session" entries.
 * Shared by every card; looked up again after a minute, or when a CLI's path changes in settings.
 */
export function useAgentClis() {
  return useQuery({
    queryKey: queryKeys.agentClis,
    queryFn: ({ signal }) => api<AgentClis>("/api/agent-clis", { signal }),
    staleTime: 60_000,
  });
}

/**
 * Whether each harness's CLI runs and has the board's MCP registered, for the settings pills. The server runs the CLIs
 * and caches the answer for a minute; Re-check asks it again.
 */
export function useAgentIntegrations() {
  return useQuery({
    queryKey: queryKeys.agentIntegrations,
    queryFn: ({ signal }) => api<AgentIntegrations>("/api/agent-integrations", { signal }),
    staleTime: 60_000,
  });
}

/**
 * The models each CLI lists, for the pickers on the Model tiers page. The server asks the CLIs (a few seconds) and
 * keeps the answer for ten minutes, so this runs only where it is `enabled`; Rescan asks again.
 */
export function useAgentModels(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agentModels,
    queryFn: ({ signal }) => api<AgentModels>("/api/agent-models", { signal }),
    // A scan that failed comes back as a reply with an error; the server doesn't keep it, so neither does this.
    staleTime: (query) => (query.state.data?.harnesses.some((h) => h.error) ? 0 : 10 * 60_000),
    enabled,
  });
}

/** CLIs, branches and the tier's models for the new-session dialog. Fetched fresh each time it opens. */
export function useSessionLaunchOptions(taskId: string | null) {
  return useQuery({
    queryKey: queryKeys.sessionLaunchOptions(taskId ?? ""),
    queryFn: ({ signal }) =>
      api<SessionLaunchOptions>(`/api/tasks/${encodeURIComponent(taskId!)}/session-launch-options`, { signal }),
    enabled: !!taskId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** What "Fix in →" starts a session with: the PR's branch and Fix PRs' prompt for its problems now. Read each time. */
export function usePrFix(linkId: string | null) {
  return useQuery({
    queryKey: queryKeys.prFix(linkId ?? ""),
    queryFn: ({ signal }) => api<PrFixInfo>(`/api/links/${encodeURIComponent(linkId!)}/fix`, { signal }),
    enabled: !!linkId,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** The board skill's install state per harness. Read on focus too: the user edits the files outside the board. */
export function useSkillSync() {
  return useQuery({
    queryKey: queryKeys.skillSync,
    queryFn: ({ signal }) => api<SkillSyncStatus>("/api/skill-sync", { signal }),
    staleTime: 0,
    refetchOnWindowFocus: true,
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotRunsAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotOrchestrateAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot });
        void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
        void queryClient.invalidateQueries({ queryKey: queryKeys.digests });
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
        // A rule's "last task" line follows that task (done, archived).
        void queryClient.invalidateQueries({ queryKey: queryKeys.recurring });
        // Whether Orchestrate has anything to look at follows the project's tasks.
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotOrchestrateAll });
      }
      // Also sent when a switch or config changes, so another window's edit refreshes the lanes' scopes.
      if (event.type === "autopilot.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotRunsAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotOrchestrateAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot });
        void queryClient.invalidateQueries({ queryKey: queryKeys.recurring });
        void queryClient.invalidateQueries({ queryKey: queryKeys.customAutomations });
        // A digest is made, read or dropped.
        void queryClient.invalidateQueries({ queryKey: queryKeys.digests });
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
      if (event.type === "suggestions.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.suggestions });
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

/** The agents' social network, for the hidden feed page. No event covers posts, so it polls while the page is open. */
export function useSocialFeed() {
  return useQuery({
    queryKey: queryKeys.socialFeed,
    queryFn: ({ signal }) => api<SocialFeed>("/api/social", { signal }),
    refetchInterval: 30_000,
  });
}

/**
 * Weekly stats for the stats page. No event covers them, so they are read when the page opens, when the period or
 * project changes (a new key) and when the window regains focus, instead of being pushed.
 */
export function useStats(weeks: StatsPeriod, projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.stats(weeks, projectId),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ weeks: String(weeks) });
      if (projectId) query.set("projectId", projectId);
      return api<StatsResponse>(`/api/stats?${query}`, { signal });
    },
    staleTime: 0,
    refetchOnWindowFocus: "always",
    // A project that no longer exists answers 404 for good; one retry is for everything else.
    retry: (failures, error) => !(error instanceof ApiError && error.status === 404) && failures < 1,
    // Keeps the old charts up (dimmed by the page) while another period or project loads.
    placeholderData: (previous) => previous,
  });
}
