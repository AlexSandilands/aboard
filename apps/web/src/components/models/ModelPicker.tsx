// Ported from T3 Code's ProviderModelPicker (MIT, see NOTICE): the trigger, and the popup holding the picker with
// its docked effort column. The adapters (ModelChoicePicker, CliModelPicker, T3ModelPicker) build what it lists.
import { ChevronDownIcon } from "lucide-react";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ComposerControl } from "~/components/handoff/T3LaunchPickers";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent, type TypedRowsFor } from "./ModelPickerContent";
import type { PickerIcon as PickerIconKind, PickerModel, PickerRow } from "./modelPicker.logic";
import { PickerIcon } from "./PickerIcon";

/** Holds the page still behind the open picker; its lifetime is the popup element's. */
function lockBackgroundScroll(popup: HTMLElement | null) {
  if (!popup) return;
  const { documentElement, body } = document;
  const previousOverscroll = documentElement.style.overscrollBehavior;
  const previousOverflow = body.style.overflow;
  const previousPaddingRight = body.style.paddingRight;
  const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
  documentElement.style.overscrollBehavior = "contain";
  body.style.overflow = "hidden";
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
  const allowed = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-model-picker-content], [data-model-picker-effort]");
  const preventWheel = (event: WheelEvent) => {
    if (!allowed(event.target)) event.preventDefault();
  };
  const preventTouch = (event: TouchEvent) => {
    if (!allowed(event.target)) event.preventDefault();
  };
  document.addEventListener("wheel", preventWheel, { capture: true, passive: false });
  document.addEventListener("touchmove", preventTouch, { capture: true, passive: false });
  return () => {
    document.removeEventListener("wheel", preventWheel, { capture: true });
    document.removeEventListener("touchmove", preventTouch, { capture: true });
    documentElement.style.overscrollBehavior = previousOverscroll;
    body.style.overflow = previousOverflow;
    body.style.paddingRight = previousPaddingRight;
  };
}

export interface ModelPickerProps {
  /**
   * What the list shows. A function is called only while the popup is open: building the rows reads every provider's
   * models, and a settings page has a dozen pickers that re-render on each change while they sit closed.
   */
  model: PickerModel | (() => PickerModel);
  typedRows?: TypedRowsFor;
  loading?: boolean;
  emptyLabel?: string;
  onPick: (row: PickerRow) => void;
  /** The trigger's text and mark; a muted "Choose a model" without one. */
  triggerLabel: string | null;
  triggerIcon: PickerIconKind | null;
  /** After the name inside the trigger, such as the effort level. */
  triggerSuffix?: string | null;
  /** The control's accessible name, e.g. "Reviewer model". */
  ariaLabel: string;
  size?: "sm" | "xs";
  className?: string;
  disabled?: boolean;
  /**
   * Docks an effort column beside the list. The popup then stays open after a pick of a model with levels, and focus
   * moves to them; a pick of a row that `closes` (a tier, the CLI's default) closes it.
   */
  effortColumn?: ReactNode;
  /** Builds the effort column only while the popup is open, in place of `effortColumn`. */
  renderEffortColumn?: () => ReactNode;
}

/** Calls `model` once the popup renders it, not while the picker sits closed. */
function LazyContent({
  model,
  ...props
}: Omit<ComponentProps<typeof ModelPickerContent>, "model"> & {
  model: ModelPickerProps["model"];
}) {
  return <ModelPickerContent model={typeof model === "function" ? model() : model} {...props} />;
}

/** Calls `render` once the popup renders it. */
function Deferred({ render }: { render: () => ReactNode }) {
  return render();
}

export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const openSettings = useOpenSettings();
  const docked = props.effortColumn !== undefined || props.renderEffortColumn !== undefined;

  /** Focuses the selected level, else the first; with "any", the column's first enabled row. */
  const focusEffort = (rows: "levels" | "any") => {
    const column = popupRef.current?.querySelector("[data-model-picker-effort]");
    const level =
      column?.querySelector<HTMLElement>('[data-effort-level][aria-checked="true"]:not(:disabled)') ??
      column?.querySelector<HTMLElement>("[data-effort-level]:not(:disabled)");
    const row =
      level ?? (rows === "any" ? column?.querySelector<HTMLElement>("[data-effort-row]:not(:disabled)") : null);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };

  const pick = (row: PickerRow) => {
    if (props.disabled) return;
    props.onPick(row);
    if (!docked || row.closes) {
      setOpen(false);
      return;
    }
    // The column renders the new model's levels once the saved choice comes back, so wait a frame past that.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => focusEffort("levels")));
  };

  const label = props.triggerLabel ?? "Choose a model";
  const tooltip = [label, props.triggerSuffix].filter(Boolean).join(" · ");

  const content = (
    <LazyContent
      model={props.model}
      typedRows={props.typedRows}
      loading={props.loading}
      emptyLabel={props.emptyLabel}
      searchInputRef={searchInputRef}
      onPick={pick}
      onRequestClose={() => setOpen(false)}
      onOpenSettings={(target) => openSettings(target)}
      {...(docked ? { docked, onFocusEffort: () => focusEffort("any") } : {})}
    />
  );

  return (
    <Popover open={open} onOpenChange={(next) => setOpen(props.disabled ? false : next)}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={props.size}
            aria-label={[props.ariaLabel, label, props.triggerSuffix].filter(Boolean).join(", ")}
            className={cn("min-w-0 max-w-64 shrink justify-between whitespace-nowrap", props.className)}
            disabled={props.disabled}
          />
        }
      >
        <span className={cn("flex min-w-0 flex-1 items-center", props.size === "xs" ? "gap-1" : "gap-1.5")}>
          {props.triggerIcon ? <PickerIcon icon={props.triggerIcon} /> : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn("min-w-0 flex-1 truncate text-left", !props.triggerLabel && "text-muted-foreground")}
                />
              }
            >
              {label}
            </TooltipTrigger>
            <TooltipPopup side="top">{tooltip}</TooltipPopup>
          </Tooltip>
          {props.triggerSuffix ? (
            <span className="max-w-24 shrink-0 truncate text-muted-foreground">{props.triggerSuffix}</span>
          ) : null}
        </span>
        <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup
        ref={(popup) => {
          popupRef.current = popup;
          const unlock = lockBackgroundScroll(popup);
          return () => {
            popupRef.current = null;
            unlock?.();
          };
        }}
        initialFocus={searchInputRef}
        align="start"
        collisionAvoidance={docked ? { align: "shift", fallbackAxisSide: "none" } : undefined}
        className="before:hidden"
        padding="none"
      >
        {docked ? (
          // One fixed height, so a model with more levels never resizes the popup; short windows shrink it.
          <div className="flex h-86.5 max-h-(--available-height) min-h-0 max-sm:h-auto max-sm:flex-col">
            {content}
            {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- catches Left from the column's own radios to return to the search */}
            <div
              data-model-picker-effort
              className="flex min-h-0 w-48 flex-col border-l border-border/70 bg-muted/40 sm:shrink-0 max-sm:h-64 max-sm:w-full max-sm:border-t max-sm:border-l-0"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" || event.altKey || event.ctrlKey || event.metaKey) return;
                event.preventDefault();
                event.stopPropagation();
                searchInputRef.current?.focus();
              }}
            >
              {props.renderEffortColumn ? <Deferred render={props.renderEffortColumn} /> : props.effortColumn}
            </div>
          </div>
        ) : (
          content
        )}
      </PopoverPopup>
    </Popover>
  );
}
