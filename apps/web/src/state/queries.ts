import type {
  ModelPricesStatus,
  AgentHarness,
  AgentCliStatus,
  AgentModels,
  AppSettings,
  OperationId,
  OperationSettings,
  AutopilotModeRow,
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
  IconCandidate,
  IntegrationsStatus,
  PrFixInfo,
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
  TrashedTask,
  TerminalInfo,
  TaskTemplate,
  ProvidersStatus,
} from "@repo/contracts";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { taskActiveRun } from "~/components/autopilot/autopilot.logic";
import { projectHasOrchestrateWork } from "~/components/autopilot/orchestrate.logic";
import { followupEpicBranch } from "~/components/handoff/handoff.logic";
import { deliverNotification } from "~/components/notifications/delivery";
import { withCreated } from "~/components/notifications/notifications.logic";
import { agentClisOf, withT3Status } from "~/components/settings/providers.logic";
import { ApiError, api, eventsUrl } from "~/lib/api";
import { snapshotCardRects } from "~/components/board/cardMotion";
import { applyBoardEvent, eventMovesCards } from "./boardReducer";
import { SETTINGS_QUERY_KEY, withPendingSettingsWrites } from "./settingsWrites";

export const queryKeys = {
  board: ["board"] as const,
  archivedTasks: ["archivedTasks"] as const,
  trash: ["trash"] as const,
  task: (id: string) => ["task", id] as const,
  settings: SETTINGS_QUERY_KEY,
  integrations: ["integrations"] as const,
  backupStatus: ["backupStatus"] as const,
  backupSetupInfo: ["backupSetupInfo"] as const,
  skillSync: ["skillSync"] as const,
  notifications: ["notifications"] as const,
  socialFeed: ["socialFeed"] as const,
  stats: (weeks: StatsPeriod, projectIds: ReadonlyArray<string>) => ["stats", weeks, projectIds.join(",")] as const,
  t3Projects: ["t3Projects"] as const,
  iconCandidates: (projectId: string) => ["iconCandidates", projectId] as const,
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
  /** Every switch that is set at any scope; under the scope prefix so each autopilot change refreshes it. */
  autopilotModes: ["autopilotScope", "modes"] as const,
  /** An epic's scope, under its project's. */
  autopilotEpicScope: (projectId: string, epicId: string) => ["autopilotScope", projectId, epicId] as const,
  /** Every runs query, for invalidation. */
  autopilotRunsAll: ["autopilotRuns"] as const,
  autopilotOrchestrateAll: ["autopilotOrchestrate"] as const,
  autopilotOrchestrate: (projectId: string) => ["autopilotOrchestrate", projectId] as const,
  autopilotRuns: (scope: AutopilotRunsScope) => ["autopilotRuns", scope] as const,
  terminal: ["terminal"] as const,
  modelPrices: ["modelPrices"] as const,
  /** The full detection; also the prefix of the CLI-only one, so invalidating it refreshes both. */
  providers: ["providers"] as const,
  providerClis: ["providers", "cli"] as const,
  agentModels: ["agentModels"] as const,
  sessionLaunchOptions: (taskId: string) => ["sessionLaunchOptions", taskId] as const,
  prFix: (linkId: string, harness: string | null) => ["prFix", linkId, harness] as const,
  templates: ["templates"] as const,
  /** Prefix of every project's recurring rules query. */
  recurring: ["recurring"] as const,
  recurringRules: (projectId: string) => ["recurring", projectId] as const,
  customAutomations: ["customAutomations"] as const,
  /** Every draft agents wrote, and each one (`["automationDrafts", id]`). */
  automationDrafts: ["automationDrafts"] as const,
  digests: ["digests"] as const,
  suggestions: ["suggestions"] as const,
};

/** Marks a Where it runs save in flight, so the event stream doesn't refetch the switches between its writes. */
export const WHERE_MUTATION_KEY = ["autopilotWhere"] as const;

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

/**
 * Every listed project's automations at once, for where each automation is on in Settings → Autopilot. Shares its
 * cache with `useAutopilotScope`.
 */
export function useAutopilotProjectScopes(projectIds: readonly string[]) {
  return useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: queryKeys.autopilotScope(projectId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<AutopilotScopeEntry[]>(`/api/autopilot/projects/${encodeURIComponent(projectId)}`, { signal }),
      staleTime: 30_000,
    })),
  });
}

/** Every switch that is set at any scope (board, projects, epics), for the Where it runs widget. One read, not one per scope. */
export function useAutopilotModes(enabled = true) {
  return useQuery({
    queryKey: queryKeys.autopilotModes,
    queryFn: ({ signal }) => api<AutopilotModeRow[]>("/api/autopilot/modes", { signal }),
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

/** The board's project ids in lane order; re-renders only when they change. */
export function useProjectIds(): ReadonlyArray<string> | undefined {
  return useQuery({ ...boardQuery, select: (board) => board.projects.map((p) => p.id) }).data;
}

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

/**
 * The epic's branch while a Done task's code is only there (see followupEpicBranch), for its card chip and its
 * follow-up hand-off; re-renders only when it changes.
 */
export function useFollowupEpicBranch(
  task: Pick<TaskSummary, "kind" | "status" | "resolution" | "integrationBranch" | "parent">,
): string | null {
  return useQuery({ ...boardQuery, select: (board) => followupEpicBranch(task, board.tasks) }).data ?? null;
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

/** The trash, for Settings → Recently deleted. Invalidated by every task.deleted and task.upserted (a restore). */
export function useTrash() {
  return useQuery({
    queryKey: queryKeys.trash,
    queryFn: ({ signal }) => api<TrashedTask[]>("/api/tasks/trash", { signal }),
  });
}

/** The query for a task's full detail; the panel, the card's prefetch and the card menus share its cache entry. */
function taskDetailQuery(taskId: string) {
  return {
    queryKey: queryKeys.task(taskId),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`, { signal }),
  };
}

/** Full task detail (plan, events). Invalidated by task.detail_changed for that task. */
export function useTaskDetail(taskId: string | null | undefined) {
  return useQuery({
    ...taskDetailQuery(taskId ?? ""),
    enabled: !!taskId,
  });
}

/**
 * Starts loading a task's detail as the pointer goes down on its card, so it has usually arrived by the click. The
 * panel then renders its contents in the same commit that mounts it, before its slide starts, instead of as a second
 * render in the middle of the slide.
 */
export function usePrefetchTaskDetail() {
  const queryClient = useQueryClient();
  return useCallback(
    (taskId: string) => void queryClient.prefetchQuery({ ...taskDetailQuery(taskId), staleTime: 5_000 }),
    [queryClient],
  );
}

/** The task's detail from the cache, or fetched when it isn't there: for menus that act on a card, which has none. */
export function fetchTaskDetail(queryClient: QueryClient, taskId: string) {
  return queryClient.fetchQuery({
    ...taskDetailQuery(taskId),
    staleTime: 30_000,
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

const settingsQuery = (queryClient: QueryClient) => ({
  queryKey: queryKeys.settings,
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    withPendingSettingsWrites(queryClient, await api<AppSettings>("/api/settings", { signal })),
});

export function useSettings() {
  const queryClient = useQueryClient();
  return useQuery(settingsQuery(queryClient));
}

/**
 * Part of the settings. The query's structural sharing keeps the result the same object while the parts it reads are
 * unchanged, so a component that reads a few settings doesn't re-render on every other one. `select` must be stable
 * (defined outside the component, or memoised).
 */
export function useSettingsSelect<T>(select: (settings: AppSettings) => T): T | undefined {
  const queryClient = useQueryClient();
  return useQuery({ ...settingsQuery(queryClient), select }).data;
}

/**
 * The settings that say what an operation runs on: `op`'s own board choice, the tiers, custom models and providers
 * (none for a picker that isn't an operation's), so a model picker or an operation's row skips other settings.
 */
export function useOperationSettings(op: OperationId | null): OperationSettings | undefined {
  const select = useCallback(
    (settings: AppSettings): OperationSettings => ({
      providers: settings.providers,
      modelTiers: settings.modelTiers,
      modelProfiles: settings.modelProfiles,
      operationModels: op && settings.operationModels[op] ? { [op]: settings.operationModels[op] } : {},
    }),
    [op],
  );
  return useSettingsSelect(select);
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

/** Where usage estimates' prices come from: LiteLLM's fetched list or the built-in table. */
export function useModelPrices(enabled = true) {
  return useQuery({
    queryKey: queryKeys.modelPrices,
    queryFn: ({ signal }) => api<ModelPricesStatus>("/api/model-prices", { signal }),
    enabled,
    staleTime: 30_000,
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
 * Every provider as detected here: its CLI, MCP registration, T3 Code's status and the models scan. The one detection
 * source, shared by Settings → Agents → Providers and every menu that offers a provider. The server caches the CLI checks for
 * a minute; Re-check asks past it (and looks for T3 Code again), and a provider change (providers.changed) asks again.
 * T3 Code's part follows integrations.changed without a refetch.
 */
export function useProviders(enabled = true) {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api<ProvidersStatus>("/api/providers", { signal }),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Whether the board can start each CLI here: the providers' CLI checks. The hand-off menus also leave out providers
 * the user didn't add (handoffClis). Shared by every card.
 */
export function useAgentClis(): { data: AgentCliStatus[] | undefined } {
  const clis = useQuery({
    queryKey: queryKeys.providerClis,
    // Only the CLI checks: the menus mustn't wait on `claude mcp list` or the model scans.
    queryFn: ({ signal }) => api<ProvidersStatus>("/api/providers?parts=cli", { signal }),
    staleTime: 60_000,
  });
  return { data: agentClisOf(clis.data) };
}

/**
 * The models each CLI lists, for the pickers on the Models page. The server asks the CLIs (a few seconds) and
 * keeps the answer for ten minutes, so this runs only where it is `enabled`; Rescan asks again.
 */
const agentModelsQuery = {
  queryKey: queryKeys.agentModels,
  queryFn: ({ signal }: { signal: AbortSignal }) => api<AgentModels>("/api/agent-models", { signal }),
  // A scan that failed comes back as a reply with an error; the server doesn't keep it, so neither does this.
  staleTime: (query: { state: { data?: AgentModels } }) =>
    query.state.data?.harnesses.some((h) => h.error) ? 0 : 10 * 60_000,
};

export function useAgentModels(enabled: boolean) {
  return useQuery({ ...agentModelsQuery, enabled });
}

/**
 * What "Fix in →" starts a session with: the PR's branch and Fix PRs' prompt for its problems now. Read each time.
 * `harness` is the CLI it starts in, since one that picks its own session id is told to link itself.
 */
export function usePrFix(linkId: string | null, harness: AgentHarness | null = null) {
  return useQuery({
    queryKey: queryKeys.prFix(linkId ?? "", harness),
    queryFn: ({ signal }) =>
      api<PrFixInfo>(
        `/api/links/${encodeURIComponent(linkId!)}/fix${harness ? `?harness=${encodeURIComponent(harness)}` : ""}`,
        { signal },
      ),
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

/** Images in the project's folder, for the icon picker's Image tab; only asked for while that tab is showing. */
export function useIconCandidates(projectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.iconCandidates(projectId ?? ""),
    queryFn: ({ signal }) =>
      api<IconCandidate[]>(`/api/projects/${encodeURIComponent(projectId ?? "")}/icon-candidates`, { signal }),
    enabled: enabled && !!projectId,
    // The folder changes under the board, so a reopened picker looks again.
    staleTime: 0,
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

/**
 * How long the launch options of a closed dialog (or a prefetch nobody opened) stay in the cache. Reopening inside it
 * shows them at once while a refresh runs; choices the user has made in the dialog are never moved by it.
 */
const LAUNCH_OPTIONS_GC_MS = 30_000;
/** Opening the hand-off menu again within this long doesn't prefetch the launch options again. */
const LAUNCH_OPTIONS_PREFETCH_STALE_MS = 15_000;

const t3LaunchOptionsQuery = (taskId: string) => ({
  queryKey: queryKeys.t3LaunchOptions(taskId),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<T3LaunchOptions>(`/api/tasks/${encodeURIComponent(taskId)}/t3-launch-options`, { signal }),
  gcTime: LAUNCH_OPTIONS_GC_MS,
  retry: false,
});

const projectT3LaunchOptionsQuery = (projectId: string) => ({
  queryKey: queryKeys.projectT3LaunchOptions(projectId),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<T3LaunchOptions>(`/api/projects/${encodeURIComponent(projectId)}/t3-launch-options`, { signal }),
  gcTime: LAUNCH_OPTIONS_GC_MS,
  retry: false,
});

/**
 * Models, refs and defaults for starting a T3 Code thread. Cached briefly (see prefetchT3LaunchOptions) but always
 * refreshed when the dialog opens, since T3 can change between two opens.
 */
export function useT3LaunchOptions(taskId: string | null) {
  return useQuery({
    ...t3LaunchOptionsQuery(taskId ?? ""),
    enabled: !!taskId,
    staleTime: 0,
  });
}

/** The same for a thread about a whole project (Suggest epics). */
export function useProjectT3LaunchOptions(projectId: string | null) {
  return useQuery({
    ...projectT3LaunchOptionsQuery(projectId ?? ""),
    enabled: !!projectId,
    staleTime: 0,
  });
}

const sessionLaunchOptionsQuery = (taskId: string) => ({
  queryKey: queryKeys.sessionLaunchOptions(taskId),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<SessionLaunchOptions>(`/api/tasks/${encodeURIComponent(taskId)}/session-launch-options`, { signal }),
  gcTime: LAUNCH_OPTIONS_GC_MS,
  retry: false,
});

/**
 * CLIs, branches and the tier's models for the new-session dialog. Cached briefly like T3's (see
 * usePrefetchSessionLaunchOptions) but always refreshed when the dialog opens.
 */
export function useSessionLaunchOptions(taskId: string | null) {
  return useQuery({ ...sessionLaunchOptionsQuery(taskId ?? ""), enabled: !!taskId, staleTime: 0 });
}

/**
 * Starts loading the launch options of a dialog the user is about to open (the hand-off menu just opened), so they
 * are there, or nearly, when it does.
 */
export function usePrefetchT3LaunchOptions() {
  const queryClient = useQueryClient();
  return (target: { taskId: string } | { projectId: string }) => {
    const staleTime = LAUNCH_OPTIONS_PREFETCH_STALE_MS;
    if ("taskId" in target) void queryClient.prefetchQuery({ ...t3LaunchOptionsQuery(target.taskId), staleTime });
    else void queryClient.prefetchQuery({ ...projectT3LaunchOptionsQuery(target.projectId), staleTime });
  };
}

/**
 * The same for the Claude Code / Copilot session dialog: its options, and the CLIs' model list its picker offers (a
 * first scan starts the CLIs, which takes seconds).
 */
export function usePrefetchSessionLaunchOptions() {
  const queryClient = useQueryClient();
  return (taskId: string) => {
    void queryClient.prefetchQuery({
      ...sessionLaunchOptionsQuery(taskId),
      staleTime: LAUNCH_OPTIONS_PREFETCH_STALE_MS,
    });
    void queryClient.prefetchQuery(agentModelsQuery);
  };
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
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
      const current = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      if (current && eventMovesCards(current, event)) snapshotCardRects();
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.trash });
        // A rule's "last task" line follows that task (done, archived).
        void queryClient.invalidateQueries({ queryKey: queryKeys.recurring });
        // Whether Orchestrate has anything to look at follows the project's tasks.
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotOrchestrateAll });
      }
      // Also sent when a switch or config changes, so another window's edit refreshes the lanes' scopes.
      if (event.type === "autopilot.changed") {
        // Each write of a Where it runs edit publishes this; refetching the scopes between them would show the edit
        // half done, and its config writes merge into the cached scope. The edit refetches them once every write is in.
        if (queryClient.isMutating({ mutationKey: WHERE_MUTATION_KEY }) === 0) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll });
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotRunsAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotOrchestrateAll });
        void queryClient.invalidateQueries({ queryKey: queryKeys.autopilot });
        void queryClient.invalidateQueries({ queryKey: queryKeys.recurring });
        void queryClient.invalidateQueries({ queryKey: queryKeys.customAutomations });
        // An agent drafted an automation, or one was imported or dismissed.
        void queryClient.invalidateQueries({ queryKey: queryKeys.automationDrafts });
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
        // Patched rather than invalidated: refetching would re-run the CLI and MCP checks on every flip of T3's status.
        queryClient.setQueryData<ProvidersStatus>(queryKeys.providers, (status) => withT3Status(status, event.t3));
      }
      if (event.type === "suggestions.changed") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.suggestions });
      }
      // Added, removed or switched elsewhere (another window, the migration's detection pass): the list follows, and
      // detection runs again since a new CLI path or provider changes what it checks.
      if (event.type === "providers.changed") {
        queryClient.setQueryData<AppSettings>(queryKeys.settings, (settings) =>
          settings ? withPendingSettingsWrites(queryClient, { ...settings, providers: event.providers }) : settings,
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agentModels });
      }
      // Restored from a backup: every cached task, setting and list may be another board's now.
      if (event.type === "board.reset") void queryClient.invalidateQueries();
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
 * projects change (a new key) and when the window regains focus, instead of being pushed.
 */
export function useStats(weeks: StatsPeriod, projectIds: ReadonlyArray<string>) {
  return useQuery({
    queryKey: queryKeys.stats(weeks, projectIds),
    queryFn: ({ signal }) => {
      const query = new URLSearchParams({ weeks: String(weeks) });
      if (projectIds.length) query.set("projectIds", projectIds.join(","));
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
