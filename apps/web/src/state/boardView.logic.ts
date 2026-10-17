import type { CollapseState } from "~/components/board/columnCollapse.logic";

/** The persisted part of the board view store. */
export interface PersistedBoardView extends CollapseState {
  attentionOnly: boolean;
  hasPrOnly: boolean;
  showArchived: boolean;
  /** Added without a bump: a stored view without it gets the default (false) when merged. */
  inProgressOnly?: boolean;
  /** Added without a bump: a stored view without it gets the default (true) when merged. */
  showPriorityLane?: boolean;
  /** Added in version 2 without a bump; a stored view without it gets the default ({}) when merged. */
  collapsedEpics?: Record<string, true>;
}

export const DEFAULT_COLLAPSE: CollapseState = { collapsedColumns: { done: true }, cellOverrides: {} };

/**
 * Upgrades a stored board view. Version 0 kept a per-lane `expandedDone` that has no per-column equivalent,
 * so it is dropped and collapse falls back to the defaults; filters are kept. Version 1 keyed the first
 * column "idea", which is now "backlog".
 */
export function migrateBoardView(persisted: unknown, version: number): PersistedBoardView {
  const old = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<string, unknown>;
  const filters = {
    attentionOnly: old.attentionOnly === true,
    hasPrOnly: old.hasPrOnly === true,
    showArchived: old.showArchived === true,
  };
  if (version < 1) return { ...filters, collapsedColumns: { ...DEFAULT_COLLAPSE.collapsedColumns }, cellOverrides: {} };
  return { ...filters, ...renameIdeaColumn(old) };
}

function renameIdeaColumn(old: Record<string, unknown>): CollapseState {
  const asRecord = (value: unknown) =>
    (typeof value === "object" && value !== null ? value : {}) as Record<string, boolean>;
  const rename = (key: string) => key.replace(/(^|:)idea$/, "$1backlog");
  const renamed = (record: Record<string, boolean>) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [rename(key), value]));
  return {
    collapsedColumns: renamed(asRecord(old.collapsedColumns)),
    cellOverrides: renamed(asRecord(old.cellOverrides)),
  };
}
