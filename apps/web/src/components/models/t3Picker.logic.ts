// The shared picker over T3 Code's catalog: T3's providers as tabs (Favorites first when there are any), their
// models, and the docked column of the model's reasoning option and fast mode. Used by a tier's T3 Code cell and the
// T3 launch dialog.
import type { T3ModelCatalog, T3ModelSelection } from "@repo/contracts";
import { findModel, modelTraits, optionValue, selectModel } from "~/components/handoff/handoff.logic";
import { FAVORITES_TAB, type EffortColumnModel, type PickerModel, type PickerRow } from "./modelPicker.logic";

export const t3RowKey = (instanceId: string, slug: string) => `t3:${instanceId.length}:${instanceId}${slug}`;

/** The instance and model a row's key names; the instance's length comes first, as either may hold a colon. */
export function parseT3RowKey(key: string): { instanceId: string; slug: string } | null {
  const match = /^t3:(\d+):/.exec(key);
  if (!match) return null;
  const rest = key.slice(match[0].length);
  const length = Number(match[1]);
  if (length > rest.length) return null;
  return { instanceId: rest.slice(0, length), slug: rest.slice(length) };
}

export function t3PickerModel(catalog: T3ModelCatalog, selection: T3ModelSelection | null): PickerModel {
  const favorites = new Set(catalog.favorites.map((f) => t3RowKey(f.instanceId, f.model)));
  const rows = catalog.providers.flatMap((provider) =>
    provider.models.map((model): PickerRow => ({
      key: t3RowKey(provider.instanceId, model.slug),
      tab: provider.instanceId,
      icon: { kind: "t3", driver: provider.driver },
      name: model.name,
      value: model.slug,
      detail: null,
      badge: model.badge === "new" ? "new" : null,
      isLegacy: model.isLegacy,
      favorite: favorites.has(t3RowKey(provider.instanceId, model.slug)),
      disabledReason: null,
      closes: !model.options.some((option) => option.type === "select" || option.id === "fastMode"),
    })),
  );
  const tabs = [
    ...(catalog.favorites.length > 0
      ? [
          {
            id: FAVORITES_TAB,
            label: "Favorites",
            icon: { kind: "favorites" } as const,
            disabledReason: null,
            notice: null,
            settingsTarget: null,
            typed: false,
          },
        ]
      : []),
    ...catalog.providers.map((provider) => ({
      id: provider.instanceId,
      label: provider.displayName,
      icon: { kind: "t3", driver: provider.driver } as const,
      disabledReason: provider.ready ? null : (provider.message ?? `${provider.displayName} isn't ready in T3 Code.`),
      notice: null,
      settingsTarget: "providers.t3-code",
      typed: false,
    })),
  ];
  const selectedKey = selection ? t3RowKey(selection.instanceId, selection.model) : null;
  return { tabs, rows, selectedKey: rows.some((row) => row.key === selectedKey) ? selectedKey : null };
}

/** The selection a picked row makes, keeping the options the new model also takes. */
export function t3SelectionForKey(
  catalog: T3ModelCatalog,
  previous: T3ModelSelection | null,
  key: string,
): T3ModelSelection | null {
  const parsed = parseT3RowKey(key);
  const entry = parsed ? findModel(catalog, { instanceId: parsed.instanceId, model: parsed.slug }) : null;
  return entry ? selectModel(previous, entry) : null;
}

/** The selected model's reasoning levels and fast mode, as the docked column shows them. */
export function t3EffortColumn(catalog: T3ModelCatalog, selection: T3ModelSelection | null): EffortColumnModel {
  const found = findModel(catalog, selection);
  const modelLabel = found?.model.name ?? "";
  if (!selection || !found) return { modelLabel, groups: [], toggles: [], note: "Pick a model to set its effort." };
  const { effort, fastMode } = modelTraits(found.model);
  const value = effort ? optionValue(selection, effort) : null;
  return {
    modelLabel,
    groups: effort
      ? [
          {
            id: effort.id,
            label: effort.label,
            options: effort.options.map((option) => ({
              id: option.id,
              label: option.label,
              isDefault: option.isDefault,
            })),
            value: typeof value === "string" ? value : null,
          },
        ]
      : [],
    toggles: fastMode
      ? [{ id: fastMode.id, label: fastMode.label, checked: optionValue(selection, fastMode) === true }]
      : [],
    note: effort || fastMode ? null : "This model has no options.",
  };
}
