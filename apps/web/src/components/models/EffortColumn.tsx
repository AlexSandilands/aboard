// Ported from T3 Code's ComposerEffortColumn (MIT, see NOTICE): the docked column beside the model list with the
// selected model's levels, and its on/off options below them. T3 Code reads its levels from provider descriptors;
// here they come in as an EffortColumnModel (a CLI's levels, or a T3 model's reasoning option and fast mode).
import { CheckIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Switch } from "~/components/ui/switch";
import { cn } from "~/lib/utils";
import type { EffortColumnModel, EffortOption } from "./modelPicker.logic";

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";
const OPTION_ROW = cn(COLUMN_ROW, "h-auto py-1");

function ColumnRow(props: { option: EffortOption; selected: boolean; tabStop: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      data-effort-row
      // Focus lands on a level after a model pick.
      data-effort-level
      // Up and Down move between rows.
      tabIndex={props.tabStop ? 0 : -1}
      className={COLUMN_ROW}
      onClick={props.onPick}
    >
      <span className="min-w-0 flex-1 truncate">{props.option.label}</span>
      {props.selected ? (
        <>
          {props.option.isDefault ? <span className="sr-only">Default</span> : null}
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </>
      ) : props.option.isDefault ? (
        <span className="text-xs text-muted-foreground/70">Default</span>
      ) : null}
    </button>
  );
}

function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-effort-row]:not(:disabled)")];
  const index = rows.findIndex((row) => row === document.activeElement);
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  event.preventDefault();
  event.stopPropagation();
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}

export function EffortColumn(props: {
  column: EffortColumnModel;
  onPick: (group: string, id: string | null) => void;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const { column } = props;
  const [first] = column.groups;
  return (
    <>
      {/* Matches the search row's box, so one rule runs across the top of the popup. */}
      <div className="shrink-0 px-3 pt-2.5">
        <div className="flex h-8.25 -translate-y-px items-center gap-2 border-b border-border/70 pb-1.5 text-sm">
          <span className="text-muted-foreground">
            {first?.label ?? (column.toggles.length ? "Options" : "Effort")}
          </span>
          <span className="ms-auto min-w-0 truncate text-xs text-muted-foreground">{column.modelLabel}</span>
        </div>
      </div>
      {/* pt-2.5 puts the first level on the same line as the first model. */}
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 pt-2.5 pb-1.5"
        onKeyDownCapture={moveBetweenRows}
      >
        {column.note ? <p className="px-2 py-1.5 text-xs leading-snug text-muted-foreground">{column.note}</p> : null}
        {column.groups.map((group, index) => {
          const shown = group.options.some((option) => option.id === group.value);
          return (
            <div
              key={group.id}
              role="radiogroup"
              aria-label={group.label}
              className={cn("flex flex-col gap-0.5", index > 0 && "mt-1 border-t border-border/70 pt-1")}
            >
              {index > 0 ? (
                <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{group.label}</div>
              ) : null}
              {group.options.map((option, optionIndex) => (
                <ColumnRow
                  key={option.id ?? "default"}
                  option={option}
                  selected={option.id === group.value}
                  tabStop={shown ? option.id === group.value : optionIndex === 0}
                  onPick={() => props.onPick(group.id, option.id)}
                />
              ))}
            </div>
          );
        })}
        {column.toggles.length > 0 ? (
          <div
            className={cn("flex flex-col gap-0.5", column.groups.length > 0 && "mt-1 border-t border-border/70 pt-1")}
          >
            {column.toggles.map((toggle, index) => (
              // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- it wraps the Switch, which renders its own button
              <label key={toggle.id} className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-xs text-muted-foreground">{toggle.label}</span>
                  <span className="truncate">{toggle.checked ? "On" : "Off"}</span>
                </span>
                <Switch
                  size="sm"
                  checked={toggle.checked}
                  onCheckedChange={(next) => props.onToggle(toggle.id, next)}
                  aria-label={toggle.label}
                  data-effort-row
                  tabIndex={column.groups.length === 0 && index === 0 ? 0 : -1}
                />
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
