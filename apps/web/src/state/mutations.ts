import type {
  AddLinkResult,
  AgentIntegrations,
  AppSettings,
  AskSettingsInput,
  AskSettingsResult,
  AutopilotConfig,
  AutopilotEngineSettings,
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
} from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, ApiError } from "~/lib/api";
import { captureCardRect } from "~/components/board/cardMotion";
import { toastManager } from "~/components/ui/toast";
import { applyMove, moveWasReverted, rollbackMove } from "./boardReducer";
import { queryKeys } from "./queries";

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

/** Permanently deletes a task; the server only allows it for archived tasks. */
export const useDeleteTask = (opts?: MutationOpts) =>
  useApiMutation((id: string) => api<void>(`/api/tasks/${enc(id)}`, { method: "DELETE" }), opts);
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
 * toasted here: check `isPlanRequired(error)` in onError and offer to write a plan.
 */
export function useMoveTask() {
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
        captureCardRect(move.original.id);
        queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (board) =>
          board ? rollbackMove(board, move.original, move.moved) : board,
        );
      }
      if (!isPlanRequired(error)) {
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

/** Runs the CLIs and the MCP checks again, past the server's cache, and shows the answer. */
export function useRecheckAgentIntegrations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<AgentIntegrations>("/api/agent-integrations?refresh=1"),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.agentIntegrations, result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentClis });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't check the integrations",
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
export const useRefreshLink = (opts?: MutationOpts) =>
  useApiMutation((linkId: string) => api<TaskLink>(`/api/links/${enc(linkId)}/refresh`, { body: {} }), opts);
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
