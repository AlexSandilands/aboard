import type { TaskStatus } from "@repo/contracts";
import { cellKey } from "./dnd.logic";

/**
 * Which cells show only their first few cards. The column header sets a default for every project;
 * a project's own toggle overrides it, keyed by `cellKey`. Overrides equal to the default are pruned,
 * so any override present means that project differs from its column.
 */
export interface CollapseState {
  collapsedColumns: Partial<Record<TaskStatus, boolean>>;
  cellOverrides: Record<string, boolean>;
}

export function isCellCollapsed(state: CollapseState, projectId: string, status: TaskStatus): boolean {
  return state.cellOverrides[cellKey(projectId, status)] ?? !!state.collapsedColumns[status];
}

export function toggleCell(state: CollapseState, projectId: string, status: TaskStatus): CollapseState {
  const key = cellKey(projectId, status);
  const next = !isCellCollapsed(state, projectId, status);
  const { [key]: _previous, ...cellOverrides } = state.cellOverrides;
  if (next !== !!state.collapsedColumns[status]) cellOverrides[key] = next;
  return { ...state, cellOverrides };
}

/** True when any of the given projects overrides the column, so the header shows a mixed state. */
export function isColumnMixed(state: CollapseState, status: TaskStatus, projectIds: ReadonlyArray<string>): boolean {
  return projectIds.some((id) => cellKey(id, status) in state.cellOverrides);
}

/**
 * The header applies to every project: it flips the column (or collapses it when mixed) and clears
 * the column's overrides, including those of projects hidden by filters.
 */
export function toggleColumn(state: CollapseState, status: TaskStatus, mixed: boolean): CollapseState {
  const suffix = `:${status}`;
  const cellOverrides = Object.fromEntries(
    Object.entries(state.cellOverrides).filter(([key]) => !key.endsWith(suffix)),
  );
  const collapsed = mixed || !state.collapsedColumns[status];
  return { collapsedColumns: { ...state.collapsedColumns, [status]: collapsed }, cellOverrides };
}
