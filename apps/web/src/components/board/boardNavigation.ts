import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback } from "react";

/** `?task=` — the task open in the detail panel. */
export function useSelectedTaskId(): string | null {
  return useSearch({ strict: false, select: (search) => search.task ?? null });
}

/** `?project=` — the project the board is scoped to. */
export function useProjectFilter(): string | null {
  return useSearch({ strict: false, select: (search) => search.project ?? null });
}

export function useOpenTask() {
  const navigate = useNavigate();
  return useCallback(
    (taskId: string) => navigate({ to: "/", search: (prev) => ({ ...prev, task: taskId }) }),
    [navigate],
  );
}

export function useCloseTask() {
  const navigate = useNavigate();
  return useCallback(() => navigate({ to: "/", search: (prev) => ({ ...prev, task: undefined }) }), [navigate]);
}

export function useSetProjectFilter() {
  const navigate = useNavigate();
  return useCallback(
    (projectId: string | null) => navigate({ to: "/", search: (prev) => ({ ...prev, project: projectId ?? undefined }) }),
    [navigate],
  );
}

/** Scrolls the board to a project's lane (lanes carry `id="lane-<projectId>"`). */
export function scrollToLane(projectId: string) {
  document.getElementById(`lane-${projectId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
