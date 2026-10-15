import type {
  AppSettings,
  BoardSnapshot,
  CloseTaskInput,
  CreateTaskInput,
  LinkInput,
  MoveTaskInput,
  PlanInput,
  PlanPhase,
  PlanStep,
  PlanStepInput,
  Project,
  ResolveFindingInput,
  ReviewFinding,
  StartT3ThreadInput,
  StepPatch,
  TaskDetail,
  TaskLink,
  TaskReview,
  TaskSummary,
  UpdateProjectInput,
  UpdateSettingsInput,
  UpdateTaskInput,
} from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, ApiError } from "~/lib/api";
import { captureCardRect } from "~/components/board/cardMotion";
import { toastManager } from "~/components/ui/toast";
import { optimisticMove } from "./boardReducer";
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

function useApiMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>, opts?: MutationOpts) {
  return useMutation({
    mutationFn: fn,
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
export const useUpdateTask = (opts?: MutationOpts) =>
  useApiMutation(
    ({ id, ...input }: UpdateTaskInput & { id: string }) =>
      api<TaskDetail>(`/api/tasks/${enc(id)}`, { method: "PATCH", body: input }),
    opts,
  );
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

/**
 * Moves a task (status and/or order) with an optimistic board update, rolled back on error.
 * PLAN_REQUIRED errors are NOT toasted here — check `isPlanRequired(error)` in onError and
 * offer to write a plan.
 */
type MoveVars = MoveTaskInput & { id: string };

const applyMove = (board: BoardSnapshot, { id, status, beforeId, afterId }: MoveVars) =>
  optimisticMove(board, id, {
    status: status ?? board.tasks.find((t) => t.id === id)?.status ?? "idea",
    beforeId,
    afterId,
  });

/**
 * Moves a task. `mutate` writes the optimistic move synchronously, so a dropped card renders in its
 * new slot in the same commit that ends the drag and the drop animation lands there. A failed move
 * slides the card back.
 */
export function useMoveTask() {
  const queryClient = useQueryClient();
  // Each move's task as it was before, keyed by the mutate() variables object, for rollback.
  const [originals] = useState(() => new WeakMap<MoveVars, TaskSummary>());
  const mutation = useMutation({
    mutationFn: ({ id, ...input }: MoveVars) => api<TaskSummary>(`/api/tasks/${enc(id)}/move`, { body: input }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board });
      // Cancelling a board fetch restores the cache from before the fetch, and a fetch that
      // landed meanwhile has the old position too: write the move again if it was undone.
      const original = originals.get(vars);
      const board = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      const task = board?.tasks.find((t) => t.id === vars.id);
      if (board && original && task?.status === original.status && task.position === original.position)
        queryClient.setQueryData(queryKeys.board, applyMove(board, vars));
    },
    onError: (error, vars) => {
      const original = originals.get(vars);
      if (original) {
        captureCardRect(original.id);
        queryClient.setQueryData<BoardSnapshot>(queryKeys.board, (board) =>
          board ? { ...board, tasks: board.tasks.map((t) => (t.id === original.id ? original : t)) } : board,
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
  const { mutate: baseMutate } = mutation;
  const mutate = useCallback<typeof baseMutate>(
    (vars, options) => {
      const board = queryClient.getQueryData<BoardSnapshot>(queryKeys.board);
      const original = board?.tasks.find((t) => t.id === vars.id);
      if (board && original) {
        originals.set(vars, original);
        queryClient.setQueryData(queryKeys.board, applyMove(board, vars));
      }
      baseMutate(vars, options);
    },
    [queryClient, originals, baseMutate],
  );
  return { ...mutation, mutate };
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

export type ReviewCliCheck = { ok: true; path: string; version: string } | { ok: false; error: string };
/** Checks the board reviewer's Claude Code CLI (the saved one unless `cli` is given). */
export const useTestReviewCli = (opts?: MutationOpts) =>
  useApiMutation((cli?: string | null) => api<ReviewCliCheck>("/api/review/test-cli", { body: { cli } }), opts);

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
  useApiMutation(
    ({ taskId, ...input }: LinkInput & { taskId: string }) =>
      api<TaskLink>(`/api/tasks/${enc(taskId)}/links`, { body: input }),
    opts,
  );
export const useStartT3Thread = (opts?: MutationOpts) =>
  useApiMutation(
    ({ taskId, ...input }: StartT3ThreadInput & { taskId: string }) =>
      api<TaskLink>(`/api/tasks/${enc(taskId)}/t3-thread`, { body: input }),
    opts,
  );
export const useRemoveLink = (opts?: MutationOpts) =>
  useApiMutation((linkId: string) => api<void>(`/api/links/${enc(linkId)}`, { method: "DELETE" }), opts);
export const useRefreshLink = (opts?: MutationOpts) =>
  useApiMutation((linkId: string) => api<TaskLink>(`/api/links/${enc(linkId)}/refresh`, { body: {} }), opts);

// ── Settings ─────────────────────────────────────────────────────────────

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
