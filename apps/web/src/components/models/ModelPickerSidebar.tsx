// Ported from T3 Code's ModelPickerSidebar (MIT, see NOTICE): the rail of provider tabs beside the model list.
import { memo, useLayoutEffect, useRef, useState } from "react";
import { Toolbar, ToolbarButton } from "~/components/ui/toolbar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { CHOICES_TAB, FAVORITES_TAB, type PickerTab } from "./modelPicker.logic";
import { PickerIcon } from "./PickerIcon";

const TOOLTIP_SIDE = "left" as const;
const TOOLTIP_SIDE_OFFSET = 8;

const BUTTON =
  "relative isolate flex w-full cursor-pointer aspect-square items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none";

export const ModelPickerSidebar = memo(function ModelPickerSidebar(props: {
  tabs: ReadonlyArray<PickerTab>;
  selectedTab: string;
  onSelectTab: (id: string) => void;
  onFocusSearch: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const item = [...(contentRef.current?.querySelectorAll<HTMLElement>("[data-model-picker-provider]") ?? [])].find(
      (element) => element.dataset.modelPickerProvider === props.selectedTab,
    );
    setIndicatorTop(item ? item.offsetTop + item.offsetHeight / 2 - 10 : null);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Adding or reordering tabs moves the selected one, so the indicator re-measures.
    props.tabs,
    props.selectedTab,
  ]);

  // The Choices and Favorites tabs sit above a rule, apart from the providers, as Favorites does in T3 Code.
  const leading = props.tabs.filter((tab) => tab.id === CHOICES_TAB || tab.id === FAVORITES_TAB);
  const providers = props.tabs.filter((tab) => !leading.includes(tab));

  const tabButton = (tab: PickerTab) => {
    const disabled = tab.disabledReason !== null;
    const selected = props.selectedTab === tab.id;
    const tooltip = disabled
      ? `${tab.label}: ${tab.disabledReason}`
      : tab.warning
        ? `${tab.label}: ${tab.warning}`
        : tab.label;
    const button = (
      <ToolbarButton
        className={cn(BUTTON, disabled && "cursor-not-allowed opacity-50 hover:bg-transparent")}
        onClick={() => !disabled && props.onSelectTab(tab.id)}
        disabled={disabled}
        // A greyed provider stays reachable by keyboard, so its reason can be read.
        focusableWhenDisabled
        aria-pressed={selected}
        aria-label={tooltip}
        type="button"
      >
        <PickerIcon icon={tab.icon} className="size-5" />
        {tab.warning && !disabled ? (
          <span
            aria-hidden="true"
            data-model-picker-warning="true"
            className="absolute end-1.5 top-1.5 size-2 rounded-full bg-warning ring-2 ring-background"
          />
        ) : null}
      </ToolbarButton>
    );
    return (
      <div key={tab.id} className="relative w-full" data-model-picker-provider={tab.id}>
        <Tooltip>
          {/* A disabled button gets no pointer events, so a wrapper carries its tooltip. */}
          <TooltipTrigger render={disabled ? <span className="relative block w-full">{button}</span> : button} />
          <TooltipPopup side={TOOLTIP_SIDE} sideOffset={TOOLTIP_SIDE_OFFSET} align="center">
            {tooltip}
          </TooltipPopup>
        </Tooltip>
      </div>
    );
  };

  return (
    <Toolbar
      className="w-11 shrink-0 overflow-hidden bg-muted/30"
      data-model-picker-sidebar="true"
      aria-label="Providers"
      orientation="vertical"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onFocusSearch();
        }
      }}
    >
      <div className="h-full overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={contentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {indicatorTop !== null ? (
            <div
              data-model-picker-selected-indicator="true"
              className="pointer-events-none absolute right-1 z-10 h-5 w-0.75 rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: indicatorTop }}
            />
          ) : null}
          {leading.map(tabButton)}
          {leading.length > 0 && providers.length > 0 ? (
            <div className="border-b border-border/70" aria-hidden="true" />
          ) : null}
          {providers.map(tabButton)}
        </div>
      </div>
    </Toolbar>
  );
});
