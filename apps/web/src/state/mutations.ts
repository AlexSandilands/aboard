import type {
  AppSettings,
  BoardSnapshot,
  CreateProjectInput,
  CreateTaskInput,
  LinkInput,
  MoveTaskInput,
  PlanInput,
  PlanPhase,
  PlanStep,
  PlanStepInput,
  Project,
  StepPatch,
  TaskDetail,
  TaskLink,
  TaskStatus,
  TaskSummary,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
} from "@taskboard/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "~/lib/api";
import { toastManager } from "~/components/ui/toast";
import { optimisticMove } from "./boardReducer";
import { queryKeys } from "./queries";

/*
 * Mutation hooks. The server pushes every change back over /events, so these don't
 * patch the cache themselves (except the optimistic task move). Errors surface as
 * toasts unless the caller passes its own onError to mutate().
 */

const enc = encodeURIComponent;

function useApiMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>, opts?: { silent?: boolean }) {
  return useMutation({
    mutationFn: fn,
    onError: (error) => {
      if (opts?.silent) return;
      toastManager.add({ type: "error", title: "Something went wrong", description: error instanceof Error ? error.message : String(error) });
    },
  });
}

// ── Projects ─────────────────────────────────────────────────────────────

export const useCreateProject = () => useApiMutation((input: CreateProjectInput) => api<Project>("/api/projects", { body: input }));
export const useUpdateProject = () =>
  useApiMutation(({ id, ...input }: UpdateProjectInput & { id: string }) => api<Project>(`/api/projects/${enc(id)}`, { method: "PATCH", body: input }));
export const useReorderProjects = () => useApiMutation((ids: string[]) => api<void>("/api/projects/reorder", { body: { ids } }));
export const useDeleteProject = () => useApiMutation((id: string) => api<void>(`/api/projects/${enc(id)}`, { method: "DELETE" }));
export const useImportT3Projects = () =>
  useApiMutation((t3ProjectIds: string[]) => api<Project[]>("/api/integrations/t3/import", { body: { t3ProjectIds } }));

// ── Tasks ────────────────────────────────────────────────────────────────

export const useCreateTask = () => useApiMutation((input: CreateTaskInput) => api<TaskDetail>("/api/tasks", { body: input }));
export const useUpdateTask = () =>
  useApiMutation(({ id, ...input }: UpdateTaskInput & { id: string }) => api<TaskDetail>(`/api/tasks/${enc(id)}`, { method: "PATCH", body: input }));
export const useAddNote = () =>
  useApiMutation(({ taskId, text }: { taskId: string; text: string }) => api<unknown>(`/api/tasks/${enc(taskId)}/notes`, { body: { text } }));

/**
 * Moves a task (status and/or order) with an optimistic board update, rolled back on error.
 * PLAN_REQUIRED errors are NOT toasted here — check `isPlanRequired(error)` in onError and
 * offer to write a plan.
 */
export function useMoveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: MoveTaskInput & { id: string }) => api<TaskSummary>(`/api/tasks/${enc(id)}/move`, { body: input }),
    onMutate: async ({ id, status, beforeId, afterId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board });
      const previous = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      if (previous) {
        const current = previous.tasks.find((t) => t.id === id);
        const target: TaskStatus = status ?? current?.status ?? "idea";
        queryClient.setQueryData(queryKeys.board, optimisticMove(previous, id, { status: target, beforeId, afterId }));
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.board, context.previous);
      if (!isPlanRequired(error)) {
        toastManager.add({ type: "error", title: "Couldn't move task", description: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

export function isPlanRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "PLAN_REQUIRED";
}

// ── Plans ────────────────────────────────────────────────────────────────

export const useSetPlan = () =>
  useApiMutation(({ taskId, plan }: { taskId: string; plan: PlanInput }) => api<TaskDetail>(`/api/tasks/${enc(taskId)}/plan`, { method: "PUT", body: plan }));
export const useAddPhase = () =>
  useApiMutation(({ taskId, title, afterPhaseId }: { taskId: string; title: string; afterPhaseId?: string }) =>
    api<PlanPhase>(`/api/tasks/${enc(taskId)}/phases`, { body: { title, afterPhaseId } }),
  );
export const useUpdatePhase = () =>
  useApiMutation(({ phaseId, title }: { phaseId: string; title: string }) => api<PlanPhase>(`/api/phases/${enc(phaseId)}`, { method: "PATCH", body: { title } }));
export const useDeletePhase = () => useApiMutation((phaseId: string) => api<void>(`/api/phases/${enc(phaseId)}`, { method: "DELETE" }));
export const useAddSteps = () =>
  useApiMutation(({ phaseId, steps, afterStepId }: { phaseId: string; steps: PlanStepInput[]; afterStepId?: string }) =>
    api<PlanStep[]>(`/api/phases/${enc(phaseId)}/steps`, { body: { steps, afterStepId } }),
  );
export const useUpdateStep = () =>
  useApiMutation(({ stepId, ...patch }: StepPatch & { stepId: string }) => api<PlanStep>(`/api/steps/${enc(stepId)}`, { method: "PATCH", body: patch }));
export const useMoveStep = () =>
  useApiMutation(({ stepId, ...to }: { stepId: string; phaseId?: string; beforeId?: string | null; afterId?: string | null }) =>
    api<PlanStep>(`/api/steps/${enc(stepId)}/move`, { body: to }),
  );
export const useDeleteStep = () => useApiMutation((stepId: string) => api<void>(`/api/steps/${enc(stepId)}`, { method: "DELETE" }));

// ── Links ────────────────────────────────────────────────────────────────

export const useAddLink = () =>
  useApiMutation(({ taskId, ...input }: LinkInput & { taskId: string }) => api<TaskLink>(`/api/tasks/${enc(taskId)}/links`, { body: input }));
export const useRemoveLink = () => useApiMutation((linkId: string) => api<void>(`/api/links/${enc(linkId)}`, { method: "DELETE" }));
export const useRefreshLink = () => useApiMutation((linkId: string) => api<TaskLink>(`/api/links/${enc(linkId)}/refresh`, { body: {} }));

// ── Settings ─────────────────────────────────────────────────────────────

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => api<AppSettings>("/api/settings", { method: "PATCH", body: input }),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.settings, settings),
    onError: (error) => toastManager.add({ type: "error", title: "Couldn't save settings", description: error instanceof Error ? error.message : String(error) }),
  });
}
