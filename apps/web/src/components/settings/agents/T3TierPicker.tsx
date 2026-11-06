// The shared T3 picker (components/models/T3ModelPicker.tsx) with a "Default model" row first in each provider's
// tab, so a tier's T3 Code model is cleared inside the picker like a CLI's, and no clear button sits beside it.
import type { T3ModelCatalog, T3ModelSelection } from "@repo/contracts";
import { findModel, modelTraits, optionValue, setOption } from "~/components/handoff/handoff.logic";
import { EffortColumn } from "~/components/models/EffortColumn";
import { ModelPicker } from "~/components/models/ModelPicker";
import { t3EffortColumn, t3PickerModel, t3SelectionForKey } from "~/components/models/t3Picker.logic";
import { isT3DefaultKey, withT3DefaultRows } from "./agents.logic";

const DEFAULT_LABEL = "Default model";

export function T3TierPicker({
  catalog,
  selection,
  onChange,
  ariaLabel,
  className,
}: {
  catalog: T3ModelCatalog;
  selection: T3ModelSelection | null;
  /** Null when the default row is picked. */
  onChange: (selection: T3ModelSelection | null) => void;
  ariaLabel: string;
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
      model={withT3DefaultRows(t3PickerModel(catalog, selection), DEFAULT_LABEL)}
      ariaLabel={ariaLabel}
      size="sm"
      className={className}
      triggerLabel={found?.model.name ?? DEFAULT_LABEL}
      triggerIcon={found ? { kind: "t3", driver: found.provider.driver } : { kind: "t3code" }}
      triggerSuffix={suffix || null}
      onPick={(row) => {
        if (isT3DefaultKey(row.key)) {
          if (selection) onChange(null);
          return;
        }
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
