// The shared model picker's data, whatever it picks from: tabs down the side (providers, plus the Choices and
// Favorites tabs), the rows each lists, what a search shows, and the effort column beside it. Built by the adapters in
// choicePicker.logic.ts (a ModelChoice, or one CLI's model) and t3Picker.logic.ts (a T3 Code model). Ported from T3
// Code's ModelPickerContent (MIT, see NOTICE).
import type { AgentHarness } from "@repo/contracts";
import { rankModelPickerSearch } from "./modelPickerSearch.logic";

/** The tab of choices that aren't one provider's model: inherit, the tiers, the custom models. */
export const CHOICES_TAB = "choices";
/** T3 Code's favorite models. */
export const FAVORITES_TAB = "favorites";

export type PickerIcon =
  | { kind: "harness"; harness: AgentHarness }
  /** A T3 Code provider instance, by its driver ("claudeAgent", "codex"). */
  | { kind: "t3"; driver: string }
  /** T3 Code itself. */
  | { kind: "t3code" }
  | { kind: "choices" }
  | { kind: "favorites" }
  /** Rows of the Choices tab. */
  | { kind: "inherit" }
  | { kind: "tier" }
  | { kind: "custom" };

export interface PickerTab {
  id: string;
  label: string;
  icon: PickerIcon;
  /** Why nothing in the tab can be picked (a provider that can't run the operation, or isn't ready). */
  disabledReason: string | null;
  /** A note under the list, such as a scan that failed. */
  notice: string | null;
  /** The settings target of the provider's own page, for the link under its list. */
  settingsTarget: string | null;
  /** A model the list doesn't have can be typed and used on this provider. */
  typed: boolean;
}

export interface PickerRow {
  /** Unique among the rows; what the combobox holds. */
  key: string;
  /** The tab it lives in. */
  tab: string;
  icon: PickerIcon;
  name: string;
  /** The model id or choice it saves, shown in mono beside a name that differs. */
  value: string;
  /** A second piece of text after the name: what a choice resolves to, a model's description. */
  detail: string | null;
  badge: "new" | null;
  /** Folded under "Show more" in its provider's tab. */
  isLegacy: boolean;
  /** Also listed under Favorites. */
  favorite: boolean;
  disabledReason: string | null;
  /** Picking it closes the popup: it has no effort to set next. */
  closes: boolean;
}

export interface PickerModel {
  tabs: PickerTab[];
  rows: PickerRow[];
  /** The row of what is saved now, when it is one. */
  selectedKey: string | null;
}

export const legacyKey = (tab: string) => `legacy:${tab}`;
export const parseLegacyKey = (key: string): string | null => (key.startsWith("legacy:") ? key.slice(7) : null);

/** The tab the picker opens on: the selected row's, else the first tab that isn't disabled, else the first. */
export function initialTab(model: PickerModel): string {
  const selected = model.rows.find((row) => row.key === model.selectedKey);
  if (selected && model.tabs.some((tab) => tab.id === selected.tab)) return selected.tab;
  return (model.tabs.find((tab) => !tab.disabledReason) ?? model.tabs[0])?.id ?? CHOICES_TAB;
}

/** The disabled reason a row shows: its own, else its tab's. */
export function rowDisabledReason(model: PickerModel, row: PickerRow): string | null {
  return row.disabledReason ?? model.tabs.find((tab) => tab.id === row.tab)?.disabledReason ?? null;
}

const tabLabel = (model: PickerModel, id: string) => model.tabs.find((tab) => tab.id === id)?.label ?? id;

export interface VisibleRows {
  /** The rows shown, in order, ending with the legacy toggle's key when the tab has legacy rows. */
  keys: string[];
  rows: Map<string, PickerRow>;
  /** The tab's legacy toggle, when it has one. */
  legacy: { key: string; expanded: boolean; count: number } | null;
}

/**
 * What the list shows. Searching ranks every row in every tab (typed rows last); otherwise the tab's rows, its legacy
 * ones folded under a toggle unless `expanded` holds the tab or one of them is selected. Favorites lists the favorite
 * rows of every tab.
 */
export function visibleRows(
  model: PickerModel,
  tab: string,
  query: string,
  expanded: ReadonlySet<string>,
  typed: readonly PickerRow[] = [],
): VisibleRows {
  const byKey = new Map<string, PickerRow>();
  if (query.trim()) {
    const ranked = rankModelPickerSearch(model.rows, query, (row) => ({
      name: row.name,
      value: row.value,
      detail: row.detail ?? undefined,
      providerName: tabLabel(model, row.tab),
      isFavorite: row.favorite,
    }));
    for (const row of [...ranked, ...typed]) byKey.set(row.key, row);
    return { keys: [...byKey.keys()], rows: byKey, legacy: null };
  }
  const inTab =
    tab === FAVORITES_TAB ? model.rows.filter((row) => row.favorite) : model.rows.filter((row) => row.tab === tab);
  const legacyRows = tab === FAVORITES_TAB ? [] : inTab.filter((row) => row.isLegacy && !row.favorite);
  const open = expanded.has(tab) || legacyRows.some((row) => row.key === model.selectedKey);
  const shown = inTab.filter((row) => open || !legacyRows.includes(row));
  for (const row of shown) byKey.set(row.key, row);
  const keys = [...byKey.keys()];
  if (legacyRows.length === 0) return { keys, rows: byKey, legacy: null };
  const key = legacyKey(tab);
  return { keys: [...keys, key], rows: byKey, legacy: { key, expanded: open, count: legacyRows.length } };
}

/** The tab a provider-switch key moves to: the next (or previous) one that isn't disabled, wrapping. */
export function adjacentTab(tabs: readonly PickerTab[], current: string, direction: 1 | -1): string {
  const ids = tabs.filter((tab) => !tab.disabledReason).map((tab) => tab.id);
  if (ids.length === 0) return current;
  const index = ids.indexOf(current);
  if (index < 0) return direction === 1 ? ids[0]! : ids.at(-1)!;
  return ids[(index + direction + ids.length) % ids.length]!;
}

/** What the trigger shows for the selected row, else `fallback`. */
export function selectedRow(model: PickerModel): PickerRow | null {
  return model.rows.find((row) => row.key === model.selectedKey) ?? null;
}

// ── The effort column ────────────────────────────────────────────────────

export interface EffortOption {
  /** null is "Default": the provider's own effort. */
  id: string | null;
  label: string;
  isDefault?: boolean;
}

/** One group of levels in the column (a CLI's effort, or a T3 model's reasoning option). */
export interface EffortGroup {
  id: string;
  label: string;
  options: EffortOption[];
  value: string | null;
}

/** An on/off option below the levels, such as T3's fast mode. */
export interface EffortToggle {
  id: string;
  label: string;
  checked: boolean;
}

export interface EffortColumnModel {
  /** The model it is for, named in the header. */
  modelLabel: string;
  groups: EffortGroup[];
  toggles: EffortToggle[];
  /** Shown instead when there is nothing to set (a tier picks its own effort). */
  note: string | null;
}
