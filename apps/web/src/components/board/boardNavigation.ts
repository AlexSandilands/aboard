import { formatProjectScope, parseProjectScope, type BoardFilterParams } from "@repo/contracts";
import { useMatch, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { boardSearchAt } from "~/components/layout/appModal.logic";
import { formatLabelFilter, parseLabelFilter } from "~/components/labels/labels.logic";
import type { BoardSearch } from "~/router";
import { useProjectIds } from "~/state/queries";
import { useReveal, useSettingsNav } from "~/state/ui";
import { clearedParams, FILTER_PARAM_KEYS, filterParams, readFilters, type FilterState } from "./boardFilters.logic";

/**
 * The board search a navigation to "/" builds on: the current one on the board, else the board as it was when
 * a window opened, so opening a task from Settings doesn't carry the project page's `?project=` onto the board.
 */
export function boardSearchFrom(prev: BoardSearch): BoardSearch {
  return boardSearchAt(window.location.pathname, prev, useSettingsNav.getState().boardReturn);
}

/**
 * Reads the board's search. The board stays mounted behind the Settings and Stats windows, whose URLs carry their
 * own search (`?project=` is the project being configured), so off the board this reads the search the board was
 * left with (`boardReturn`). On the board it reads the board route's own match, whose search is the validated one
 * (`BoardSearch`): the layout route these hooks are rendered under only has the raw values, where `?q=2024` is a
 * number. `select` must return a primitive, as both sources compare by identity.
 */
function useBoardSearch<T extends string | number | boolean | null | undefined>(select: (search: BoardSearch) => T): T {
  // Whether the board route is matched, not the location's path: the two change in different renders during a
  // navigation, and the search below exists exactly while the match does.
  const onBoard = useMatch({ from: "/_app/", shouldThrow: false, select: () => true }) === true;
  const url = useSearch({ from: "/_app/", shouldThrow: false, select: (search): unknown => select(search) });
  const kept = useSettingsNav((s) => (onBoard ? undefined : select(s.boardReturn)));
  return (onBoard ? url : kept) as T;
}

/** `?task=` — the task open in the detail panel. */
export function useSelectedTaskId(): string | null {
  return useBoardSearch((search) => search.task ?? null);
}

/**
 * `?project=` — the projects the board is scoped to, in lane order; empty is every project. Ids of projects that
 * don't exist (any more) are dropped once the board has loaded.
 */
export function useProjectFilter(): ReadonlyArray<string> {
  const raw = useBoardSearch((search) => search.project);
  const order = useProjectIds();
  return useMemo(() => parseProjectScope(raw, order), [raw, order]);
}

/** `?labels=`: the labels the board is filtered to (any of them). */
export function useLabelFilter(): string[] {
  const raw = useBoardSearch((search) => search.labels);
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

/**
 * Brings the open task's card into view on the board, from the panel's jump action or its shortcut. Unlike the reveal
 * made when a task opens, it ignores the scroll setting and says why when the card can't be shown.
 */
export function useJumpToTask() {
  return useCallback((taskId: string) => useReveal.getState().requestReveal(taskId, { explicit: true }), []);
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
  return useBoardSearch((search) => search.epic ?? null);
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
  const key = useBoardSearch((search) => JSON.stringify(FILTER_PARAM_KEYS.map((name) => search[name])));
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

/** Scopes the board to these projects. None, or every project, is the whole board. */
export function useSetProjectScope() {
  const navigate = useNavigate();
  const order = useProjectIds();
  return useCallback(
    (projectIds: ReadonlyArray<string>) => {
      const project = order ? formatProjectScope(projectIds, order) : projectIds.join(",") || undefined;
      return navigate({
        to: "/",
        // The in-progress filter looks across every project, so choosing some ends it.
        search: (prev) => ({ ...boardSearchFrom(prev), project, ...(project ? { inprogress: undefined } : {}) }),
      });
    },
    [navigate, order],
  );
}

/** Scrolls the board to a project's lane (lanes carry `id="lane-<projectId>"`). */
export function scrollToLane(projectId: string) {
  document.getElementById(`lane-${projectId}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
