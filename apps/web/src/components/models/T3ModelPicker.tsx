import type { T3ModelCatalog, T3ModelSelection } from "@repo/contracts";
import { findModel, modelTraits, optionValue, setOption } from "~/components/handoff/handoff.logic";
import { EffortColumn } from "./EffortColumn";
import { ModelPicker } from "./ModelPicker";
import { t3EffortColumn, t3PickerModel, t3SelectionForKey } from "./t3Picker.logic";

/**
 * A T3 Code model with its reasoning option and fast mode: the shared picker over T3's catalog, for a tier's T3 Code
 * cell and the T3 launch dialog.
 */
export function T3ModelPicker({
  catalog,
  selection,
  onChange,
  ariaLabel = "Model",
  size,
  className,
}: {
  catalog: T3ModelCatalog;
  selection: T3ModelSelection | null;
  onChange: (selection: T3ModelSelection) => void;
  ariaLabel?: string;
  size?: "sm" | "xs";
  className?: string;
}) {
  const found = findModel(catalog, selection);
  const { effort, fastMode } = modelTraits(found?.model);
  const effortValue = selection && effort ? optionValue(selection, effort) : null;
  const suffix = [
    effort?.options.find((option) => option.id === effortValue)?.label,
    selection && fastMode && optionValue(selection, fastMode) === true ? fastMode.label : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <ModelPicker
      model={t3PickerModel(catalog, selection)}
      ariaLabel={ariaLabel}
      size={size}
      className={className}
      triggerLabel={found?.model.name ?? null}
      triggerIcon={found ? { kind: "t3", driver: found.provider.driver } : null}
      triggerSuffix={suffix || null}
      onPick={(row) => {
        const next = t3SelectionForKey(catalog, selection, row.key);
        if (next) onChange(next);
      }}
      effortColumn={
        <EffortColumn
          column={t3EffortColumn(catalog, selection)}
          onPick={(id, value) => {
            if (selection && value !== null) onChange(setOption(selection, id, value));
          }}
          onToggle={(id, checked) => {
            if (selection) onChange(setOption(selection, id, checked));
          }}
        />
      }
    />
  );
}
