import type { StepStatus, TaskDetail } from "@taskboard/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  useAddPhase,
  useAddSteps,
  useDeletePhase,
  useDeleteStep,
  useMoveStep,
  useUpdatePhase,
  useUpdateStep,
} from "~/state/mutations";
import { queryKeys } from "~/state/queries";
import {
  applyStepOrder,
  patchPhase,
  patchStep,
  placementOf,
  removePhase,
  removeStep,
  type StepOrder,
} from "./plan.logic";

/**
 * Plan mutations with an optimistic patch of the cached task detail, so the timeline and
 * the "you are here" marker move instantly. The SSE-driven refetch then replaces the
 * patch with server truth; on error the detail is refetched (and the mutation toasts).
 */
export function usePlanActions(taskId: string) {
  const queryClient = useQueryClient();
  const { mutate: mutateUpdateStep } = useUpdateStep();
  const { mutate: mutateMoveStep } = useMoveStep();
  const { mutate: mutateDeleteStep } = useDeleteStep();
  const { mutate: mutateAddSteps } = useAddSteps();
  const { mutate: mutateAddPhase } = useAddPhase();
  const { mutate: mutateUpdatePhase } = useUpdatePhase();
  const { mutate: mutateDeletePhase } = useDeletePhase();

  return useMemo(() => {
    const key = queryKeys.task(taskId);
    const patch = (fn: (detail: TaskDetail) => TaskDetail) => {
      void queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<TaskDetail>(key, (detail) => (detail ? fn(detail) : detail));
    };
    const onError = () => void queryClient.invalidateQueries({ queryKey: key });

    return {
      setStepStatus(stepId: string, status: StepStatus) {
        patch((d) => patchStep(d, stepId, { status }));
        mutateUpdateStep({ stepId, status }, { onError });
      },
      renameStep(stepId: string, title: string) {
        patch((d) => patchStep(d, stepId, { title }));
        mutateUpdateStep({ stepId, title }, { onError });
      },
      setStepNotes(stepId: string, notes: string | null) {
        patch((d) => patchStep(d, stepId, { notes }));
        mutateUpdateStep({ stepId, notes }, { onError });
      },
      deleteStep(stepId: string) {
        patch((d) => removeStep(d, stepId));
        mutateDeleteStep(stepId, { onError });
      },
      /** Persists a drag: `order` is the full post-drop order, `stepId` the dragged step. */
      moveStep(stepId: string, order: StepOrder) {
        const placement = placementOf(order, stepId);
        if (!placement) return;
        patch((d) => applyStepOrder(d, order));
        mutateMoveStep({ stepId, ...placement }, { onError });
      },
      addStep(phaseId: string, title: string, afterStepId?: string) {
        mutateAddSteps({ phaseId, steps: [{ title }], ...(afterStepId ? { afterStepId } : {}) });
      },
      addPhase(title: string, afterPhaseId?: string, onSuccess?: () => void) {
        mutateAddPhase({ taskId, title, ...(afterPhaseId ? { afterPhaseId } : {}) }, { onSuccess });
      },
      renamePhase(phaseId: string, title: string) {
        patch((d) => patchPhase(d, phaseId, { title }));
        mutateUpdatePhase({ phaseId, title }, { onError });
      },
      deletePhase(phaseId: string) {
        patch((d) => removePhase(d, phaseId));
        mutateDeletePhase(phaseId, { onError });
      },
    };
  }, [queryClient, taskId, mutateUpdateStep, mutateMoveStep, mutateDeleteStep, mutateAddSteps, mutateAddPhase, mutateUpdatePhase, mutateDeletePhase]);
}

export type PlanActions = ReturnType<typeof usePlanActions>;
