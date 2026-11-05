// Ported from T3 Code's ModelListRow (MIT, see NOTICE): one row of the model list. Favorites and jump shortcuts are
// T3 Code's own and left out; a row here may also be a choice (inherit, a tier, a custom model) with what it
// resolves to after its name.
import { CheckIcon } from "lucide-react";
import { memo } from "react";
import { ComboboxItem } from "~/components/ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { PickerRow } from "./modelPicker.logic";
import { PickerIcon } from "./PickerIcon";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  row: PickerRow;
  /** The provider's name, read out after the row's for screen readers (the logo is decorative). */
  providerLabel: string;
  isSelected: boolean;
  disabledReason: string | null;
}) {
  const { row } = props;
  const showValue = row.value && row.value !== row.name && !row.name.includes(row.value);
  const content = (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={row.key}
      disabled={props.disabledReason !== null}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason && "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      <PickerIcon icon={row.icon} className="text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <div
          className="min-w-0 truncate text-sm font-normal leading-snug"
          // Names the row in full on hover only when it is cut off.
          onPointerEnter={(event) => {
            const name = event.currentTarget;
            name.title = name.scrollWidth > name.clientWidth ? row.name : "";
          }}
        >
          {row.name}
          <span className="sr-only">, {props.providerLabel}</span>
        </div>
        {showValue ? (
          <span className="min-w-0 shrink truncate font-mono text-2xs text-muted-foreground/70">{row.value}</span>
        ) : null}
        {row.detail ? (
          <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70" title={row.detail}>
            {row.detail}
          </span>
        ) : null}
        {row.badge === "new" ? (
          <span
            className="shrink-0 rounded border border-info/40 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-info"
            aria-label="New model"
          >
            New
          </span>
        ) : null}
      </div>
      {/* Always reserved, so the check keeps a fixed column. */}
      <CheckIcon className={cn("size-3.5 shrink-0", !props.isSelected && "invisible")} aria-hidden="true" />
    </ComboboxItem>
  );

  if (!props.disabledReason) return content;
  return (
    <Tooltip>
      <TooltipTrigger render={content} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
