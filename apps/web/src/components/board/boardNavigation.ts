import type { BoardFilterParams } from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { formatLabelFilter, parseLabelFilter } from "~/components/labels/labels.logic";
import type { BoardSearch } from "~/router";
import { useReveal, useSettingsNav } from "~/state/ui";
import { clearedParams, FILTER_PARAM_KEYS, filterParams, readFilters, type FilterState } from "./boardFilters.logic";

/**
 * The board search a navigation to "/" builds on: the current one on the board, else the board as it was when
 * Settings opened, so opening a task from Settings doesn't carry the project page's `?project=` onto the board.
 */
export function boardSearchFrom(prev: BoardSearch): BoardSearch {
  return window.location.pathname === "/" ? prev : useSettingsNav.getState().boardReturn;
}

/** `?task=` — the task open in the detail panel. */
export function useSelectedTaskId(): string | null {
  return useSearch({ strict: false, select: (search) => search.task ?? null });
}

/** `?project=` — the project the board is scoped to. */
export function useProjectFilter(): string | null {
  return useSearch({ strict: false, select: (search) => search.project ?? null });
}

/** `?labels=`: the labels the board is filtered to (any of them). */
export function useLabelFilter(): string[] {
  const raw = useSearch({ strict: false, select: (search) => search.labels });
  return useMemo(() => parseLabelFilter(raw), [raw]);
}

export function useSetLabelFilter() {
  const navigate = useNavigate();
  return useCallback(
    (labels: ReadonlyArray<string>) =>
      navigate({ to: "/", search: (prev) => ({ ...boardSearchFrom(prev), labels: formatLabelFilter(labels) }) }),
    [navigate],
  );
}

/**
 * Opens a task in the panel and scrolls the board to its card (when the setting is on). A click on the card itself
 * passes `reveal: false`: the card is already under the pointer.
 */
export function useOpenTask() {
  const navigate = useNavigate();
  return useCallback(
    (taskId: string, options?: { reveal?: boolean }) => {
      const opened = navigate({ to: "/", search: (prev) => ({ ...boardSearchFrom(prev), task: taskId }) });
      // After the navigation, so the board has the task selected (which keeps its card in a collapsed column) by then.
      if (options?.reveal !== false)
        void opened.then(
          () => useReveal.getState().requestReveal(taskId),
          () => {}, // the caller sees the failure
        );
      return opened;
    },
    [navigate],
  );
}

export function useCloseTask() {
  const navigate = useNavigate();
  return useCallback(
    () => navigate({ to: "/", search: (prev) => ({ ...boardSearchFrom(prev), task: undefined }) }),
    [navigate],
  );
}

/** `?epic=`: the epic the board is filtered to. */
export function useEpicFilter(): string | null {
  return useSearch({ strict: false, select: (search) => search.epic ?? null });
}

export function useSetEpicFilter() {
  const navigate = useNavigate();
  return useCallback(
    (epicId: string | null) =>
      navigate({ to: "/", search: (prev) => ({ ...boardSearchFrom(prev), epic: epicId ?? undefined }) }),
    [navigate],
  );
}

/** The search's filter params (the project scope included), as one value that only changes when they do. */
export function useBoardFilterParams(): BoardFilterParams {
  const key = useSearch({
    strict: false,
    select: (search) => JSON.stringify(FILTER_PARAM_KEYS.map((name) => search[name])),
  });
  return useMemo(() => {
    const values = JSON.parse(key) as unknown[];
    return Object.fromEntries(FILTER_PARAM_KEYS.map((name, i) => [name, values[i] ?? undefined]));
  }, [key]);
}

/** The board's filters, read from the URL. */
export function useBoardFilters(): FilterState {
  const params = useBoardFilterParams();
  return useMemo(() => readFilters(params), [params]);
}

/** Changes some filters and leaves the rest, the project scope and the open task as they are. */
export function useSetBoardFilters() {
  const navigate = useNavigate();
  return useCallback(
    (patch: Partial<FilterState>, options?: { replace?: boolean }) =>
      navigate({
        to: "/",
        replace: options?.replace,
        search: (prev) => {
          const base = boardSearchFrom(prev);
          return { ...base, ...filterParams({ ...readFilters(base), ...patch }, base.project) };
        },
      }),
    [navigate],
  );
}

/** Turns every filter off. The project scope stays: it has its own control in the header. */
export function useResetFilters() {
  const navigate = useNavigate();
  return useCallback(
    () => navigate({ to: "/", search: (prev) => ({ ...boardSearchFrom(prev), ...clearedParams() }) }),
    [navigate],
  );
}

/** Replaces the board's filters, the project scope included, with a saved view's. The open task stays. */
export function useApplyFilterParams() {
  const navigate = useNavigate();
  return useCallback(
    (params: BoardFilterParams) =>
      navigate({
        to: "/",
        search: (prev) => ({ ...boardSearchFrom(prev), ...clearedParams(), project: undefined, ...params }),
      }),
    [navigate],
  );
}

export function useSetProjectFilter() {
  const navigate = useNavigate();
  return useCallback(
    (projectId: string | null) =>
      navigate({
        to: "/",
        // The in-progress filter looks across every project, so choosing one ends it.
        search: (prev) => ({
          ...boardSearchFrom(prev),
          project: projectId ?? undefined,
          ...(projectId ? { inprogress: undefined } : {}),
        }),
      }),
    [navigate],
  );
}

/** Scrolls the board to a project's lane (lanes carry `id="lane-<projectId>"`). */
export function scrollToLane(projectId: string) {
  document.getElementById(`lane-${projectId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
