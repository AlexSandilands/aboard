import type { CollapseState } from "~/components/board/columnCollapse.logic";

/** The persisted part of the board view store. */
export interface PersistedBoardView extends CollapseState {
  /** Added without a bump: a stored view without it gets the default (true) when merged. */
  showPriorityLane?: boolean;
  /** Added in version 2 without a bump; a stored view without it gets the default ({}) when merged. */
  collapsedEpics?: Record<string, true>;
  /** Added without a bump: a stored view without it gets the default (false) when merged. */
  pinPriorityLane?: boolean;
  /** Added without a bump: a stored view without it gets the default ("medium") when merged. */
  pinnedLaneHeight?: PinnedLaneHeight;
}

/** How much of the viewport the pinned priority lane may take once it is stuck, in viewport heights. */
export const PINNED_LANE_HEIGHTS = {
  small: { label: "Small", vh: 20 },
  medium: { label: "Medium", vh: 30 },
  large: { label: "Large", vh: 45 },
} as const;

export type PinnedLaneHeight = keyof typeof PINNED_LANE_HEIGHTS;

export const DEFAULT_PINNED_LANE_HEIGHT: PinnedLaneHeight = "medium";

/** The stuck lane's `max-height`. A stored value that isn't one of the sizes falls back to the default. */
export function pinnedLaneMaxHeight(height: unknown): string {
  const known = typeof height === "string" && Object.hasOwn(PINNED_LANE_HEIGHTS, height);
  return `${PINNED_LANE_HEIGHTS[known ? (height as PinnedLaneHeight) : DEFAULT_PINNED_LANE_HEIGHT].vh}vh`;
}

export const DEFAULT_COLLAPSE: CollapseState = { collapsedColumns: { done: true }, cellOverrides: {} };

/**
 * Upgrades a stored board view. Version 0 kept a per-lane `expandedDone` that has no per-column equivalent,
 * so it is dropped and collapse falls back to the defaults. Version 1 keyed the first column "idea", which is now
 * "backlog". The filters older versions stored (`attentionOnly`, `hasPrOnly`, `showArchived`, `inProgressOnly`) are
 * dropped: filters are the board's URL params now.
 */
export function migrateBoardView(persisted: unknown, version: number): PersistedBoardView {
  const old = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<string, unknown>;
  if (version < 1) return { collapsedColumns: { ...DEFAULT_COLLAPSE.collapsedColumns }, cellOverrides: {} };
  return renameIdeaColumn(old);
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
