import { applyWhereWrites, type AutopilotMode, type WhereTarget } from "@repo/contracts";
import type {
  ModelPricesStatus,
  DeleteTasksResult,
  AddLinkResult,
  AgentModels,
  AppSettings,
  AskSettingsInput,
  AskSettingsResult,
  AutopilotConfig,
  AutopilotEngineSettings,
  AutopilotModeRow,
  AutopilotOnMode,
  AutopilotOverview,
  AutopilotRun,
  AutopilotScopeEntry,
  AutopilotStatus,
  BoardSnapshot,
  OrchestrateState,
  CloseTaskInput,
  CreateTaskInput,
  CreateTemplateInput,
  EpicDelivery,
  LinkInput,
  MergePrInput,
  MoveTaskInput,
  InboxNotification,
  NotificationList,
  PlanInput,
  PlanPhase,
  PlanStep,
  PlanStepInput,
  Project,
  ResolveFindingInput,
  ResumeMode,
  ResumeResult,
  ReviewFinding,
  StartPlanningSessionInput,
  StartPlanningThreadInput,
  StartSessionInput,
  StartSessionResult,
  StartT3ThreadInput,
  StepPatch,
  T3ThreadRef,
  TaskDetail,
  TaskLink,
  TaskReview,
  TaskSummary,
  UpdateAutopilotEngineInput,
  UpdateAutopilotSettingInput,
  TaskTemplate,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
  UpdateTemplateInput,
  ProviderSetting,
  ProvidersStatus,
} from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, ApiError } from "~/lib/api";
import { snapshotCardRects } from "~/components/board/cardMotion";
import { toastManager } from "~/components/ui/toast";
import { applyMove, moveWasReverted, rollbackMove } from "./boardReducer";
import { queryKeys, WHERE_MUTATION_KEY } from "./queries";

/*
 * Mutation hooks. The server pushes every change back over /events, so these don't
 * patch the cache themselves (except the optimistic task move). Errors surface as
 * toasts unless the caller passes its own onError to mutate().
 */

const enc = encodeURIComponent;

/** Pass `{ silent: true }` when the caller handles errors itself (avoids a duplicate toast). */
export interface MutationOpts {
  silent?: boolean;
}

function useApiMutation<TVars, TResult>(
  fn: (vars: TVars) => Promise<TResult>,
  opts?: MutationOpts,
  onSuccess?: () => void,
) {
  return useMutation({
    mutationFn: fn,
    onSuccess,
    onError: (error) => {
      if (opts?.silent) return;
      toastManager.add({
        type: "error",
        title: "Something went wrong",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

// ── Projects ─────────────────────────────────────────────────────────────

export const useUpdateProject = (opts?: MutationOpts) =>
  useApiMutation(
    ({ id, ...input }: UpdateProjectInput & { id: string }) =>
      api<Project>(`/api/projects/${enc(id)}`, { method: "PATCH", body: input }),
    opts,
  );
/** The General project, unarchived or made again when needed. */
export const useGeneralProject = (opts?: MutationOpts) =>
  useApiMutation(() => api<Project>("/api/projects/general", { method: "POST", body: {} }), opts);
export const useReorderProjects = (opts?: MutationOpts) =>
  useApiMutation((ids: string[]) => api<void>("/api/projects/reorder", { body: { ids } }), opts);
export const useDeleteProject = (opts?: MutationOpts) =>
  useApiMutation((id: string) => api<void>(`/api/projects/${enc(id)}`, { method: "DELETE" }), opts);
export const useImportT3Projects = (opts?: MutationOpts) =>
  useApiMutation(
    (t3ProjectIds: string[]) => api<Project[]>("/api/integrations/t3/import", { body: { t3ProjectIds } }),
    opts,
  );

// ── Tasks ────────────────────────────────────────────────────────────────

export const useCreateTask = (opts?: MutationOpts) =>
  useApiMutation((input: CreateTaskInput) => api<TaskDetail>("/api/tasks", { body: input }), opts);
/** Runs a failed import again; the server's events show it pending. */
export const useRetryImport = (opts?: MutationOpts) =>
  useApiMutation(
    (taskId: string) => api<TaskSummary>(`/api/tasks/${enc(taskId)}/import/retry`, { method: "POST", body: {} }),
    opts,
  );
/** Dismisses an agent's request for attention; the server's events take it off the card. */
export const useDismissAttentionRequest = (opts?: MutationOpts) =>
  useApiMutation(
    (taskId: string) => api<TaskSummary>(`/api/tasks/${enc(taskId)}/attention-request`, { method: "DELETE" }),
    opts,
  );
export const useUpdateTask = (opts?: MutationOpts) =>
  useApiMutation(
    ({ id, ...input }: UpdateTaskInput & { id: string }) =>
      api<TaskDetail>(`/api/tasks/${enc(id)}`, { method: "PATCH", body: input }),
    opts,
  );
/** Sets an epic's delivery; switching to integration makes its branch on origin first, so it can take a moment. */
export const useSetEpicDelivery = (epicId: string, opts?: MutationOpts) =>
  useApiMutation(
    (delivery: EpicDelivery) =>
      api<TaskDetail>(`/api/tasks/${enc(epicId)}/delivery`, { method: "PUT", body: { delivery } }),
    opts,
  );
/**
 * Marks an integration epic merged into the default branch, for when no PR the board watches shows it. A move to Done is
 * how the server takes it, and only once all the epic's tasks are Done; the board updates from its event.
 */
export const useMarkEpicMerged = (epicId: string, opts?: MutationOpts) =>
  useApiMutation(() => api<TaskSummary>(`/api/tasks/${enc(epicId)}/move`, { body: { status: "done" } }), opts);
// ── Templates ───────────────────────────────────────────────────────────

/** Templates aren't part of the board snapshot or its events (only the UI edits them), so each change refetches the list. */
function useTemplateMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>, opts?: MutationOpts) {
  const queryClient = useQueryClient();
  return useApiMutation(fn, opts, () => void queryClient.invalidateQueries({ queryKey: queryKeys.templates }));
}

export const useCreateTemplate = (opts?: MutationOpts) =>
  useTemplateMutation((input: CreateTemplateInput) => api<TaskTemplate>("/api/templates", { body: input }), opts);
export const useUpdateTemplate = (opts?: MutationOpts) =>
  useTemplateMutation(
    ({ id, ...input }: UpdateTemplateInput & { id: string }) =>
      api<TaskTemplate>(`/api/templates/${enc(id)}`, { method: "PATCH", body: input }),
    opts,
  );
export const useDuplicateTemplate = (opts?: MutationOpts) =>
  useTemplateMutation(
    (id: string) => api<TaskTemplate>(`/api/templates/${enc(id)}/duplicate`, { method: "POST", body: {} }),
    opts,
  );
export const useDeleteTemplate = (opts?: MutationOpts) =>
  useTemplateMutation((id: string) => api<void>(`/api/templates/${enc(id)}`, { method: "DELETE" }), opts);

// ── Labels ───────────────────────────────────────────────────────────────

/**
 * Replaces a task's labels. Calls share a scope so they reach the server in order: each sends the whole list,
 * so a later edit overtaking an earlier one would be undone by it.
 */
export const useSetTaskLabels = (taskId: string) =>
  useMutation({
    mutationFn: (labels: string[]) =>
      api<TaskDetail>(`/api/tasks/${enc(taskId)}`, { method: "PATCH", body: { labels } }),
    scope: { id: `task-labels:${taskId}` },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Couldn't update the labels",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });

/** Sets a label's colour override, or clears it with `hue: null`; the cached board updates at once. */
export function useSetLabelColor(opts?: MutationOpts) {
  const queryClient = useQueryClient();
  const setColors = (labelColors: Record<string, number>) =>
    queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (board) => (board ? { ...board, labelColors } : board));
  return useMutation({
    mutationFn: ({ label, hue }: { label: string; hue: number | null }) =>
      hue === null
        ? api<Record<string, number>>(`/api/labels/${enc(label)}/color`, { method: "DELETE" })
        : api<Record<string, number>>(`/api/labels/${enc(label)}/color`, { method: "PUT", body: { hue } }),
    onMutate: ({ label, hue }) => {
      const board = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      if (!board) return;
      const { [label]: _previous, ...rest } = board.labelColors;
      setColors(hue === null ? rest : { ...rest, [label]: hue });
    },
    onSuccess: setColors,
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.board });
      if (opts?.silent) return;
      toastManager.add({
        type: "error",
        title: "Couldn't change the label colour",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/**
 * Moves tasks to the trash: one through DELETE (with its epic's tasks when `withTasks`), several in one bulk write.
 * Resolves with the ids that went, for Undo.
 */
export const useDeleteTasks = (opts?: MutationOpts) =>
  useApiMutation(
    ({ ids, withTasks }: { ids: readonly string[]; withTasks?: boolean }) =>
      ids.length === 1
        ? api<DeleteTasksResult>(`/api/tasks/${enc(ids[0]!)}${withTasks ? "?withTasks=1" : ""}`, { method: "DELETE" })
        : api<DeleteTasksResult>("/api/tasks/bulk-delete", { body: { tasks: ids } }),
    opts,
  );
/** Brings tasks back out of the trash (Undo, or Settings → Recently deleted). */
export const useRestoreTasks = (opts?: MutationOpts) =>
  useApiMutation(
    (ids: readonly string[]) => api<{ restored: string[] }>("/api/tasks/restore", { body: { tasks: ids } }),
    opts,
  );
/** Removes trashed tasks for good (Settings → Recently deleted → Delete now). */
export const usePurgeTasks = (opts?: MutationOpts) =>
  useApiMutation((ids: readonly string[]) => api<void>("/api/tasks/trash/purge", { body: { tasks: ids } }), opts);
/** Closes a task as done by / duplicate of another task, or won't do. Named apart from the panel's useCloseTask. */
export const useResolveTask = (opts?: MutationOpts) =>
  useApiMutation(
    ({ id, ...input }: CloseTaskInput & { id: string }) =>
      api<TaskDetail>(`/api/tasks/${enc(id)}/close`, { body: input }),
    opts,
  );
export const useAddNote = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, text }: { taskId: string; text: string }) =>
      api<unknown>(`/api/tasks/${enc(taskId)}/notes`, { body: { text } }),
    opts,
  );

type MoveVars = MoveTaskInput & { id: string };

/**
 * Moves a task (status and/or order). `mutate` and `mutateAsync` write the optimistic move
 * synchronously, so a dropped card renders in its new slot in the same commit that ends the drag and
 * the drop animation lands there. A failed move slides the card back. PLAN_REQUIRED errors are NOT
 * toasted here: check `isPlanRequired(error)` in onError and offer to write a plan. `silent` skips the error toast
 * for a caller that reports failures itself (the card menu's bulk move).
 */
export function useMoveTask(opts?: MutationOpts) {
  const queryClient = useQueryClient();
  // Each move's task before and after the optimistic write, keyed by the variables object.
  const [moves] = useState(() => new WeakMap<MoveVars, { original: TaskSummary; moved: TaskSummary }>());
  const mutation = useMutation({
    mutationFn: ({ id, ...input }: MoveVars) => api<TaskSummary>(`/api/tasks/${enc(id)}/move`, { body: input }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board });
      // Cancelling a board fetch restores the cache from before the fetch, and a fetch that
      // landed meanwhile has the old position too: write the move again if it was undone.
      const move = moves.get(vars);
      const board = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      if (board && move && moveWasReverted(board, move.original))
        queryClient.setQueryData(queryKeys.board, applyMove(board, vars));
    },
    onError: (error, vars) => {
      const move = moves.get(vars);
      if (move) {
        snapshotCardRects(move.original.id);
        queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (board) =>
          board ? rollbackMove(board, move.original, move.moved) : board,
        );
      }
      if (!isPlanRequired(error) && !opts?.silent) {
        toastManager.add({
          type: "error",
          title: "Couldn't move task",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  const writeOptimistic = useCallback(
    (vars: MoveVars) => {
      const board = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      const original = board?.tasks.find((t) => t.id === vars.id);
      if (!board || !original) return;
      const next = applyMove(board, vars);
      snapshotCardRects();
      const moved = next.tasks.find((t) => t.id === vars.id);
      if (moved) moves.set(vars, { original, moved });
      queryClient.setQueryData(queryKeys.board, next);
    },
    [queryClient, moves],
  );
  const { mutate: baseMutate, mutateAsync: baseMutateAsync } = mutation;
  const mutate = useCallback<typeof baseMutate>(
    (vars, options) => {
      writeOptimistic(vars);
      baseMutate(vars, options);
    },
    [writeOptimistic, baseMutate],
  );
  const mutateAsync = useCallback<typeof baseMutateAsync>(
    (vars, options) => {
      writeOptimistic(vars);
      return baseMutateAsync(vars, options);
    },
    [writeOptimistic, baseMutateAsync],
  );
  return { ...mutation, mutate, mutateAsync };
}

export function isPlanRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "PLAN_REQUIRED";
}

// ── Local review ─────────────────────────────────────────────────────────

/** Opens the next review round (past the round limit too: it's the user asking). */
export const useStartReview = (opts?: MutationOpts) =>
  useApiMutation((taskId: string) => api<TaskReview>(`/api/tasks/${enc(taskId)}/reviews`, { body: {} }), opts);
export const useResolveFinding = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, finding, ...input }: ResolveFindingInput & { taskId: string; finding: string }) =>
      api<ReviewFinding>(`/api/tasks/${enc(taskId)}/findings/${enc(finding)}`, { method: "PATCH", body: input }),
    opts,
  );

/** Asks the CLIs for their models again, past the server's cache, and shows the answer. */
export function useRescanAgentModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<AgentModels>("/api/agent-models?refresh=1"),
    onSuccess: (result) => queryClient.setQueryData(queryKeys.agentModels, result),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't scan for models",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** Runs every provider check again, past the server's cache, and shows the answer. */
export function useRecheckProviders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<ProvidersStatus>("/api/providers?refresh=1"),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.providers, result);
      // The CLI-only answer the menus read was refreshed with it.
      void queryClient.invalidateQueries({ queryKey: queryKeys.providerClis });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't check the providers",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** The review loop prompt for pasting into any harness. */
export const fetchReviewPrompt = async (taskId: string): Promise<string> =>
  (await api<{ prompt: string }>(`/api/tasks/${enc(taskId)}/review-prompt`)).prompt;

// ── Plans ────────────────────────────────────────────────────────────────

export const useSetPlan = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, plan }: { taskId: string; plan: PlanInput }) =>
      api<TaskDetail>(`/api/tasks/${enc(taskId)}/plan`, { method: "PUT", body: plan }),
    opts,
  );
export const useAddPhase = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, title, afterPhaseId }: { taskId: string; title: string; afterPhaseId?: string }) =>
      api<PlanPhase>(`/api/tasks/${enc(taskId)}/phases`, { body: { title, afterPhaseId } }),
    opts,
  );
export const useUpdatePhase = (opts?: MutationOpts) =>
  useApiMutation(
    ({ phaseId, title }: { phaseId: string; title: string }) =>
      api<PlanPhase>(`/api/phases/${enc(phaseId)}`, { method: "PATCH", body: { title } }),
    opts,
  );
export const useDeletePhase = (opts?: MutationOpts) =>
  useApiMutation((phaseId: string) => api<void>(`/api/phases/${enc(phaseId)}`, { method: "DELETE" }), opts);
export const useAddSteps = (opts?: MutationOpts) =>
  useApiMutation(
    ({ phaseId, steps, afterStepId }: { phaseId: string; steps: PlanStepInput[]; afterStepId?: string }) =>
      api<PlanStep[]>(`/api/phases/${enc(phaseId)}/steps`, { body: { steps, afterStepId } }),
    opts,
  );
export const useUpdateStep = (opts?: MutationOpts) =>
  useApiMutation(
    ({ stepId, ...patch }: StepPatch & { stepId: string }) =>
      api<PlanStep>(`/api/steps/${enc(stepId)}`, { method: "PATCH", body: patch }),
    opts,
  );
export const useMoveStep = (opts?: MutationOpts) =>
  useApiMutation(
    ({ stepId, ...to }: { stepId: string; phaseId?: string; beforeId?: string | null; afterId?: string | null }) =>
      api<PlanStep>(`/api/steps/${enc(stepId)}/move`, { body: to }),
    opts,
  );
export const useDeleteStep = (opts?: MutationOpts) =>
  useApiMutation((stepId: string) => api<void>(`/api/steps/${enc(stepId)}`, { method: "DELETE" }), opts);

// ── Links ────────────────────────────────────────────────────────────────

export const useAddLink = (opts?: MutationOpts) =>
  useApiMutation(async ({ taskId, ...input }: LinkInput & { taskId: string }) => {
    const link = await api<AddLinkResult>(`/api/tasks/${enc(taskId)}/links`, { body: input });
    // The link is in; the warning says what the server couldn't check (e.g. that a T3 thread exists).
    if (link.warning) toastManager.add({ type: "warning", title: "Link added", description: link.warning });
    return link;
  }, opts);
export const useStartT3Thread = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, ...input }: StartT3ThreadInput & { taskId: string }) =>
      api<TaskLink>(`/api/tasks/${enc(taskId)}/t3-thread`, { body: input }),
    opts,
  );
/** Starts a thread about a whole project (Suggest epics); nothing is linked, so it returns the thread. */
export const useStartProjectT3Thread = (opts?: MutationOpts) =>
  useApiMutation(
    ({ projectId, ...input }: StartT3ThreadInput & { projectId: string }) =>
      api<T3ThreadRef>(`/api/projects/${enc(projectId)}/t3-thread`, { body: input }),
    opts,
  );
/** Starts a T3 Code thread that plans several of a project's tasks; its links arrive over SSE. */
export const useStartPlanningThread = (opts?: MutationOpts) =>
  useApiMutation(
    ({ projectId, ...input }: StartPlanningThreadInput & { projectId: string }) =>
      api<TaskLink[]>(`/api/projects/${enc(projectId)}/plan-thread`, { body: input }),
    opts,
  );
/** Starts a CLI session that plans several of a project's tasks, in its checkout; its links arrive over SSE. */
export const useStartPlanningSession = (opts?: MutationOpts) =>
  useApiMutation(
    ({ projectId, ...input }: StartPlanningSessionInput & { projectId: string }) =>
      api<StartSessionResult>(`/api/projects/${enc(projectId)}/plan-session`, { body: input }),
    opts,
  );
/** Starts a Claude Code or Copilot CLI session on a task in a terminal; the link arrives over SSE. */
export const useStartSession = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, ...input }: StartSessionInput & { taskId: string }) =>
      api<StartSessionResult>(`/api/tasks/${enc(taskId)}/sessions`, { body: input }),
    opts,
  );
export const useRemoveLink = (opts?: MutationOpts) =>
  useApiMutation((linkId: string) => api<void>(`/api/links/${enc(linkId)}`, { method: "DELETE" }), opts);
/** Reads a link now. An unchanged PR sends no event, so the task is refetched for its new `syncedAt` ("checked Ns ago"). */
export const useRefreshLink = (opts?: MutationOpts) => {
  const queryClient = useQueryClient();
  return useApiMutation(async (linkId: string) => {
    const link = await api<TaskLink>(`/api/links/${enc(linkId)}/refresh`, { body: {} });
    void queryClient.invalidateQueries({ queryKey: queryKeys.task(link.taskId) });
    return link;
  }, opts);
};
/** Merges a PR, or turns auto-merge on or off. The snapshot and any move to Done arrive over SSE. */
export const useMergePr = (opts?: MutationOpts) =>
  useApiMutation(
    ({ linkId, ...input }: MergePrInput & { linkId: string }) =>
      api<TaskLink>(`/api/links/${enc(linkId)}/merge`, { body: input }),
    opts,
  );
/**
 * Opens an agent session in a terminal. A running session comes back as a CONFLICT ApiError carrying its status;
 * a terminal that won't start comes back as `launched: false` with the command to copy.
 */
export const useResumeSession = (opts?: MutationOpts) =>
  useApiMutation(
    ({ linkId, ...input }: { linkId: string; mode: ResumeMode; force?: boolean }) =>
      api<ResumeResult>(`/api/links/${enc(linkId)}/resume`, { body: input }),
    opts,
  );

// ── Settings ─────────────────────────────────────────────────────────────

/** Asks the settings a question in plain words. A failed run is a reply (`ok: false`), not an error. */
export function useAskSettings() {
  return useMutation({
    mutationFn: (input: AskSettingsInput) =>
      api<AskSettingsResult>("/api/settings/ask", { method: "POST", body: input }),
  });
}

/**
 * Fetches LiteLLM's price list now (the server allows one a minute) and re-reads what the prices change: task usage and
 * the stats.
 */
export function useRefreshModelPrices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<ModelPricesStatus>("/api/model-prices/refresh", { method: "POST" }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.modelPrices, status);
      void queryClient.invalidateQueries({ queryKey: ["task"] });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't refresh model prices",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => api<AppSettings>("/api/settings", { method: "PATCH", body: input }),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.settings, settings),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save settings",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/**
 * Changes the added providers. The server replaces the whole list, so `change` is a function from the latest cached
 * list to the new one: calls share a scope so they reach the server in order, and each is built when it runs, after
 * the one before has updated the cache. Building it from what the page last rendered would let a quick second edit
 * (switching two providers on in a row) undo the first. Other windows' changes arrive as providers.changed.
 */
export function useUpdateProviders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: (current: ProviderSetting[]) => ProviderSetting[]) => {
      const current = queryClient.getQueryData<AppSettings>(queryKeys.settings)?.providers ?? [];
      return api<AppSettings>("/api/settings", { method: "PATCH", body: { providers: change(current) } });
    },
    scope: { id: "providers" },
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
      void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
    },
    // Here rather than in mutate()'s options: those only run for the latest call, and a save can be queued behind.
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toastManager.add({
        type: "error",
        title: "Couldn't save the providers",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

// ── Autopilot ────────────────────────────────────────────────────────────

/**
 * Sets one automation's mode and/or config at the board (`projectId` null), a project, or one of its epics
 * (`epicId`). The server replaces a scope's whole config, so `config` is a function from the latest cached config to
 * the new one: calls share a scope so they reach the server in order, and each is built when it runs, after the one
 * before has updated the cache. Building it from what the component last rendered would let a quick second edit undo
 * the first. The server's reply (the scope's entries) goes into the cache; other windows' changes arrive as
 * autopilot.changed.
 */
export function useSetAutopilotScope(projectId: string | null, onRejected?: () => void, epicId?: string) {
  const queryClient = useQueryClient();
  const queryKey =
    projectId && epicId ? queryKeys.autopilotEpicScope(projectId, epicId) : queryKeys.autopilotScope(projectId);
  const path = projectId ? `projects/${enc(projectId)}${epicId ? `/epics/${enc(epicId)}` : ""}` : "board";
  return useMutation({
    mutationFn: ({
      automation,
      mode,
      config,
    }: {
      automation: string;
      mode?: UpdateAutopilotSettingInput["mode"];
      config?: (current: AutopilotConfig) => AutopilotConfig;
    }) => {
      const entries = queryClient.getQueryData<AutopilotScopeEntry[]>(queryKey);
      const current = entries?.find((entry) => entry.automation === automation)?.config ?? {};
      const body: UpdateAutopilotSettingInput = { mode, config: config?.(current) };
      return api<AutopilotScopeEntry[]>(`/api/autopilot/${path}/${enc(automation)}`, { method: "PUT", body });
    },
    scope: { id: `autopilot-scope:${epicId ?? projectId ?? "board"}` },
    onSuccess: (entries) => {
      queryClient.setQueryData(queryKey, entries);
      // A board or project change moves what everything below it inherits.
      void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll });
    },
    // Here rather than in mutate()'s options: those only run for the latest call, and a save can be queued behind.
    onError: (error) => {
      onRejected?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll });
      toastManager.add({
        type: "error",
        title: "Couldn't save the Autopilot setting",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/** What an edit does at one scope: its mode (unset keeps it) and config keys (undefined removes a key), saved together. */
export interface WhereScopeWrite {
  target: WhereTarget;
  mode?: AutopilotMode;
  config?: Record<string, unknown>;
}

const whereScopeKey = (target: WhereTarget) =>
  target.kind === "board"
    ? queryKeys.autopilotScope(null)
    : target.kind === "project"
      ? queryKeys.autopilotScope(target.id)
      : queryKeys.autopilotEpicScope(target.projectId, target.id);

/**
 * Saves the scope writes an edit in the Where it runs widget came to (see `autopilotWhere.ts` in contracts), one PUT
 * each, in order. A scope's mode and config go in one PUT, and config keys merge over the scope's latest saved config
 * (the server replaces it whole), as `useSetAutopilotScope` does. The widget's rows update at once; the scopes as they
 * were are put back if one is refused, and the event stream's refetches of them wait until the last write is in (see
 * `useBoardEvents`).
 */
export function useApplyWhere(automation: string) {
  const queryClient = useQueryClient();
  const patched = (config: AutopilotConfig, keys: Record<string, unknown>): AutopilotConfig => {
    const next = { ...config };
    for (const [key, value] of Object.entries(keys)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  };
  return useMutation({
    mutationKey: WHERE_MUTATION_KEY,
    mutationFn: async (writes: ReadonlyArray<WhereScopeWrite>) => {
      for (const { target, mode, config } of writes) {
        const path =
          target.kind === "board"
            ? "board"
            : target.kind === "project"
              ? `projects/${enc(target.id)}`
              : `projects/${enc(target.projectId)}/epics/${enc(target.id)}`;
        const queryKey = whereScopeKey(target);
        const current = config
          ? (queryClient.getQueryData<AutopilotScopeEntry[]>(queryKey)?.find((e) => e.automation === automation)
              ?.config ?? {})
          : {};
        const entries = await api<AutopilotScopeEntry[]>(`/api/autopilot/${path}/${enc(automation)}`, {
          method: "PUT",
          body: { mode, ...(config ? { config: patched(current, config) } : {}) },
        });
        if (config) queryClient.setQueryData(queryKey, entries);
      }
    },
    scope: { id: `autopilot-where:${automation}` },
    onMutate: async (writes) => {
      // A refetch already on its way would land over the optimistic rows.
      await queryClient.cancelQueries({ queryKey: queryKeys.autopilotScopeAll });
      const modes = queryClient.getQueryData<AutopilotModeRow[]>(queryKeys.autopilotModes);
      queryClient.setQueryData<AutopilotModeRow[]>(queryKeys.autopilotModes, (rows) =>
        rows
          ? applyWhereWrites(
              rows,
              automation,
              writes.flatMap((w) => (w.mode ? [{ target: w.target, mode: w.mode }] : [])),
            )
          : rows,
      );
      const scopes = writes.flatMap(({ target, config }) => {
        if (!config) return [];
        const queryKey = whereScopeKey(target);
        const previous = queryClient.getQueryData<AutopilotScopeEntry[]>(queryKey);
        queryClient.setQueryData<AutopilotScopeEntry[]>(queryKey, (entries) =>
          entries?.map((e) => (e.automation === automation ? { ...e, config: patched(e.config, config) } : e)),
        );
        return [{ queryKey, previous }];
      });
      return { modes, scopes };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll }),
    onError: (error, _writes, context) => {
      // The server may have kept the writes before the refused one; the refetch after this shows what it did keep.
      if (context?.modes) queryClient.setQueryData(queryKeys.autopilotModes, context.modes);
      for (const { queryKey, previous } of context?.scopes ?? []) queryClient.setQueryData(queryKey, previous);
      toastManager.add({
        type: "error",
        title: "Couldn't save where it runs",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/**
 * Quick setup's Apply: each switch-on (quickSetupWrites) as a board-scope write, one after another. The server has no
 * batch, and the writes are independent: when one is refused the rest still apply, and the error says which.
 */
export function useApplyQuickSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (writes: ReadonlyArray<{ automation: string; mode: AutopilotOnMode }>) => {
      const failed: string[] = [];
      for (const { automation, mode } of writes) {
        try {
          await api<AutopilotScopeEntry[]>(`/api/autopilot/board/${enc(automation)}`, {
            method: "PUT",
            body: { mode } satisfies UpdateAutopilotSettingInput,
          });
        } catch (error) {
          failed.push(`${automation}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failed.length > 0) throw new Error(failed.join("; "));
    },
    scope: { id: "autopilot-scope:board" },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: queryKeys.autopilotScopeAll }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Quick setup couldn't switch everything on",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** Updates the engine's limits; `quietHours` may be partial. */
export function useUpdateAutopilotEngine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAutopilotEngineInput) =>
      api<AutopilotEngineSettings>("/api/autopilot/engine", { method: "PATCH", body: input }),
    onSuccess: (engine) =>
      queryClient.setQueryData<AutopilotOverview>(queryKeys.autopilot, (current) =>
        current ? { ...current, engine } : current,
      ),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't save the Autopilot limits",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** Pause all, and back. Runs already going finish; the board's autopilot status arrives over /events. */
export function useSetAutopilotPaused() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) =>
      api<AutopilotStatus>(`/api/autopilot/${paused ? "pause" : "resume"}`, { body: {} }),
    onSuccess: ({ paused }) =>
      queryClient.setQueryData<AutopilotOverview>(queryKeys.autopilot, (current) =>
        current ? { ...current, paused } : current,
      ),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change Pause all",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
}

/** Lets Autopilot try a failed or skipped run again; autopilot.changed refreshes the runs. */
export const useRetryAutopilotRun = () =>
  useApiMutation((id: string) => api<AutopilotRun>(`/api/autopilot/runs/${enc(id)}/retry`, { method: "POST" }));

/** Dismisses a run's needs-attention flag without redoing its work; autopilot.changed refreshes the runs and cards. */
export const useDismissAutopilotRun = () =>
  useApiMutation((id: string) => api<AutopilotRun>(`/api/autopilot/runs/${enc(id)}/dismiss`, { method: "POST" }));

/**
 * Orchestrate's Run now in a project. The reply is the new state, written into the cache so the button shows the
 * request at once; autopilot.changed brings the run. A refusal (off, paused, quiet hours, a cap) is the toast.
 */
export function useRunOrchestrateNow(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<OrchestrateState>(`/api/autopilot/orchestrate/${enc(projectId)}/run`, { method: "POST" }),
    onSuccess: (state) => queryClient.setQueryData(queryKeys.autopilotOrchestrate(projectId), state),
    onError: (error) => {
      toastManager.add({
        type: "warning",
        title: "Orchestrate didn't start",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/** Marks one notification read. The server's notifications.changed event refreshes the inbox. */
export function useMarkNotificationRead() {
  return useApiMutation(
    (id: string) => api<InboxNotification>(`/api/notifications/${enc(id)}/read`, { method: "POST" }),
    {
      silent: true,
    },
  );
}

/** Marks a task's unread notifications read, for when its panel opens. The notifications.changed event does the rest. */
export function useMarkTaskNotificationsRead() {
  return useApiMutation((taskId: string) => api<NotificationList>("/api/notifications/read", { body: { taskId } }), {
    silent: true,
  });
}

export function useMarkAllNotificationsRead() {
  return useApiMutation(() => api<NotificationList>("/api/notifications/read-all", { method: "POST" }));
}
