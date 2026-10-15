import type { CollapseState } from "~/components/board/columnCollapse.logic";

/** The persisted part of the board view store. */
export interface PersistedBoardView extends CollapseState {
  attentionOnly: boolean;
  hasPrOnly: boolean;
  showArchived: boolean;
}

export const DEFAULT_COLLAPSE: CollapseState = { collapsedColumns: { done: true }, cellOverrides: {} };

/**
 * Upgrades a stored board view from before version 1. Version 0 kept a per-lane `expandedDone` that has
 * no per-column equivalent, so it is dropped and collapse falls back to the defaults; filters are kept.
 */
export function migrateBoardView(persisted: unknown): PersistedBoardView {
  const old = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<string, unknown>;
  return {
    attentionOnly: old.attentionOnly === true,
    hasPrOnly: old.hasPrOnly === true,
    showArchived: old.showArchived === true,
    collapsedColumns: { ...DEFAULT_COLLAPSE.collapsedColumns },
    cellOverrides: {},
  };
}
