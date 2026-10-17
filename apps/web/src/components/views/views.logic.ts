import { SAVED_VIEW_NAME_MAX, SAVED_VIEWS_MAX, type BoardFilterParams, type SavedView } from "@repo/contracts";
import { normalizeParams, sameFilters } from "~/components/board/boardFilters.logic";

/** Why a view can't have this name, or null when it can. `ignoreId` is the view being renamed. */
export function viewNameError(views: ReadonlyArray<SavedView>, name: string, ignoreId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the view a name.";
  if (trimmed.length > SAVED_VIEW_NAME_MAX) return `Keep it to ${SAVED_VIEW_NAME_MAX} characters.`;
  const taken = views.some((v) => v.id !== ignoreId && v.name.toLowerCase() === trimmed.toLowerCase());
  return taken ? "A view with that name already exists." : null;
}

/** Whether another view fits. */
export const canAddView = (views: ReadonlyArray<SavedView>) => views.length < SAVED_VIEWS_MAX;

/** The views with a new one at the end. Its filters are stored normalised, so equal filters are stored equally. */
export function addView(
  views: ReadonlyArray<SavedView>,
  id: string,
  name: string,
  filters: BoardFilterParams,
): SavedView[] {
  return [...views, { id, name: name.trim(), filters: normalizeParams(filters) }];
}

export function renameView(views: ReadonlyArray<SavedView>, id: string, name: string): SavedView[] {
  return views.map((view) => (view.id === id ? { ...view, name: name.trim() } : view));
}

export function removeView(views: ReadonlyArray<SavedView>, id: string): SavedView[] {
  return views.filter((view) => view.id !== id);
}

/** The views with one put back at its old place (or the end, when the list is shorter now). A view already there stays. */
export function restoreView(views: ReadonlyArray<SavedView>, view: SavedView, index: number): SavedView[] {
  if (views.some((v) => v.id === view.id)) return [...views];
  const next = [...views];
  next.splice(Math.min(index, next.length), 0, view);
  return next;
}

/** The view whose filters are the board's now, if any. */
export function activeView(views: ReadonlyArray<SavedView>, params: BoardFilterParams): SavedView | null {
  return views.find((view) => sameFilters(view.filters, params)) ?? null;
}
