// Ported from T3 Code's ModelPickerContent (MIT, see NOTICE): the provider rail, the search and the virtualised
// model list in one combobox. T3 Code's favorites store, jump shortcuts and provider setup notices are its own; here
// a tab may note a failed scan, links to its provider's settings, and a provider that takes typed models offers the
// search text as one.
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { memo, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { InlineButton } from "~/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxSearchInput,
} from "~/components/ui/combobox";
import { getVirtualizedScrollFadeClassName } from "~/components/ui/scroll-area";
import { TooltipProvider } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  adjacentTab,
  CHOICES_TAB,
  initialTab,
  parseLegacyKey,
  rowDisabledReason,
  visibleRows,
  type PickerModel,
  type PickerRow,
} from "./modelPicker.logic";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";

const MODEL_LIST_ESTIMATED_ITEM_SIZE = 32;

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
}) {
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateScrollFades = () => {
    const scrollElement = listRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) return;
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  };

  const itemListKey = JSON.stringify(itemKeys);
  const [fadesResetFor, setFadesResetFor] = useState(itemListKey);
  if (fadesResetFor !== itemListKey) {
    setFadesResetFor(itemListKey);
    setShowTopScrollFade(false);
    setShowBottomScrollFade(itemKeys.length > 5);
  }
  const measureScrollFades = useEffectEvent(updateScrollFades);
  useLayoutEffect(() => {
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      measureScrollFades();
      nestedFrame = window.requestAnimationFrame(() => measureScrollFades());
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new list re-measures its scroll fades once it has laid out.
  }, [itemListKey]);

  return (
    <div className={cn("relative min-h-0 overflow-hidden pr-px", itemKeys.length > 0 ? "flex-1" : "h-0")}>
      <ComboboxListVirtualized>
        <LegendList<string>
          ref={listRef}
          data={itemKeys}
          extraData={extraData}
          keyExtractor={(key) => key}
          renderItem={renderItem}
          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
          drawDistance={480}
          recycleItems
          contentContainerClassName="pl-2 pr-px"
          ItemSeparatorComponent={ModelListSeparator}
          onLayout={updateScrollFades}
          onScroll={updateScrollFades}
          className={cn(
            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
            getVirtualizedScrollFadeClassName({ top: showTopScrollFade, bottom: showBottomScrollFade }),
          )}
        />
      </ComboboxListVirtualized>
    </div>
  );
}

/** What the search offers as typed, for the open tab. */
export type TypedRowsFor = (query: string, tab: string) => { rows: PickerRow[]; error: string | null };

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  model: PickerModel;
  /** The search text as a model of its own, where a provider takes typed models. */
  typedRows?: TypedRowsFor;
  /** Shown when nothing is listed and nothing matches. */
  emptyLabel?: string;
  /** The list is still loading, so an empty one doesn't mean there are no models. */
  loading?: boolean;
  onPick: (row: PickerRow) => void;
  onOpenSettings?: (target: string) => void;
  onRequestClose?: () => void;
  /** The owning popup moves focus here when it opens (its `initialFocus`). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Sits beside an effort column: fills the shared row, and stacks above it on narrow screens. */
  docked?: boolean;
  /** Right at the end of the search text moves into the popup's effort column. */
  onFocusEffort?: () => void;
}) {
  const { model, searchInputRef, onPick, onRequestClose } = props;
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState(() => initialTab(model));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [searchHeight, setSearchHeight] = useState(0);
  const listRef = useRef<LegendListRef | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const highlightedKeyRef = useRef<string | null>(null);

  const isSearching = query.trim().length > 0;
  const typed = isSearching ? (props.typedRows?.(query, tab) ?? { rows: [], error: null }) : { rows: [], error: null };
  const visible = visibleRows(model, tab, query, expanded, typed.rows);
  const allKeys = [...new Set([...model.rows.map((row) => row.key), ...visible.keys])];
  const showSidebar = !isSearching && model.tabs.length > 1;
  const openTab = model.tabs.find((entry) => entry.id === tab);

  const focusSearch = () => searchInputRef.current?.focus({ preventScroll: true });
  const selectTab = (id: string) => {
    setTab(id);
    window.requestAnimationFrame(focusSearch);
  };
  const toggleLegacy = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Picks the row a key names, unless it is disabled. False when nothing was picked. */
  const pickKey = (key: string): boolean => {
    const legacyTab = parseLegacyKey(key);
    if (legacyTab) {
      toggleLegacy(legacyTab);
      return false;
    }
    const row = visible.rows.get(key) ?? model.rows.find((entry) => entry.key === key);
    if (!row || rowDisabledReason(model, row)) return false;
    onPick(row);
    return true;
  };

  const tabLabel = (id: string) => model.tabs.find((entry) => entry.id === id)?.label ?? "";

  return (
    <TooltipProvider delay={0}>
      <div
        ref={contentRef}
        className={cn(
          "relative flex w-screen max-w-90 flex-row overflow-hidden",
          props.docked ? "max-sm:h-56 max-sm:w-full max-sm:max-w-none" : "h-86.5 max-h-(--available-height)",
        )}
        style={!props.docked && isSearching && searchHeight ? { height: searchHeight } : undefined}
        data-model-picker-content="true"
      >
        {showSidebar ? (
          <ModelPickerSidebar tabs={model.tabs} selectedTab={tab} onSelectTab={selectTab} onFocusSearch={focusSearch} />
        ) : null}
        <Combobox<string>
          inline
          items={allKeys}
          filteredItems={visible.keys}
          filter={null}
          autoHighlight
          open
          virtualized
          value={model.selectedKey}
          onItemHighlighted={(key, details) => {
            highlightedKeyRef.current = typeof key === "string" ? key : null;
            if (details.reason === "keyboard" && details.index >= 0) {
              void listRef.current?.scrollIndexIntoView?.({ index: details.index, animated: false });
            }
          }}
          onValueChange={(key) => {
            if (typeof key === "string") pickKey(key);
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            <ComboboxSearchInput
              ref={searchInputRef}
              placeholder={openTab?.typed ? "Search models or type one..." : "Search models..."}
              value={query}
              aria-invalid={typed.error ? true : undefined}
              onChange={(event) => {
                if (!isSearching) setSearchHeight(contentRef.current?.offsetHeight ?? 0);
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) {
                  (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  event.stopPropagation();
                  return;
                }
                const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
                if (
                  showSidebar &&
                  plain &&
                  ((event.key === "ArrowLeft" && !event.shiftKey && query.length === 0) ||
                    (event.key === "Tab" && event.shiftKey))
                ) {
                  const sidebar = event.currentTarget
                    .closest("[data-model-picker-content]")
                    ?.querySelector("[data-model-picker-sidebar]");
                  const button =
                    sidebar?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)') ??
                    sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                  if (button) {
                    event.preventDefault();
                    event.stopPropagation();
                    button.focus();
                    return;
                  }
                }
                // Ctrl+[ and Ctrl+] move between providers, as T3 Code's modelPicker.previous/nextProvider do.
                if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === "[" || event.key === "]")) {
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                  selectTab(adjacentTab(model.tabs, tab, event.key === "]" ? 1 : -1));
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  onRequestClose?.();
                  return;
                }
                if (
                  props.onFocusEffort &&
                  event.key === "ArrowRight" &&
                  plain &&
                  !event.shiftKey &&
                  event.currentTarget.selectionStart === query.length
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  // The column shows the selected model's effort, so a highlighted model is picked first; the popup
                  // then moves focus to its levels.
                  const highlighted = highlightedKeyRef.current;
                  const pickedNew = highlighted !== null && highlighted !== model.selectedKey && pickKey(highlighted);
                  if (!pickedNew) props.onFocusEffort();
                  return;
                }
                if (event.key === "Enter" && highlightedKeyRef.current) {
                  (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  event.preventDefault();
                  event.stopPropagation();
                  pickKey(highlightedKeyRef.current);
                  return;
                }
                event.stopPropagation();
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onTouchStart={(event) => event.stopPropagation()}
            />
            <ModelPickerList
              listRef={listRef}
              itemKeys={visible.keys}
              extraData={{ selectedKey: model.selectedKey, rows: visible.rows }}
              renderItem={({ item: key, index }) => {
                if (visible.legacy?.key === key) {
                  return (
                    <ComboboxItem
                      hideIndicator
                      index={index}
                      value={key}
                      aria-expanded={visible.legacy.expanded}
                      className="group w-full cursor-pointer"
                    >
                      <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground group-data-highlighted:text-foreground">
                        {visible.legacy.expanded ? "Show less" : `Show ${visible.legacy.count} more`}
                      </span>
                    </ComboboxItem>
                  );
                }
                const row = visible.rows.get(key);
                if (!row) return null;
                return (
                  <ModelListRow
                    key={key}
                    index={index}
                    row={row}
                    providerLabel={tabLabel(row.tab)}
                    isSelected={key === model.selectedKey}
                    disabledReason={rowDisabledReason(model, row)}
                  />
                );
              }}
            />
            {typed.error ? (
              <p className="shrink-0 px-3 py-3 text-center text-xs text-destructive-foreground">{typed.error}</p>
            ) : (
              <ComboboxEmpty className="empty:h-0">
                {visible.keys.length > 0
                  ? null
                  : props.loading && model.rows.length === 0
                    ? "Loading models..."
                    : (props.emptyLabel ?? "No models found")}
              </ComboboxEmpty>
            )}
            <TabFooter
              notice={isSearching ? null : (openTab?.notice ?? null)}
              settingsTarget={isSearching ? null : (openTab?.settingsTarget ?? null)}
              settingsLabel={
                openTab?.id === CHOICES_TAB ? "Edit tiers and custom models" : `${openTab?.label} settings`
              }
              onOpenSettings={
                props.onOpenSettings
                  ? (target) => {
                      onRequestClose?.();
                      props.onOpenSettings?.(target);
                    }
                  : undefined
              }
            />
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});

/** Under the open tab's list: why it is short (a failed scan), and a link to where its models are set. */
function TabFooter({
  notice,
  settingsTarget,
  settingsLabel,
  onOpenSettings,
}: {
  notice: string | null;
  settingsTarget: string | null;
  settingsLabel: string;
  onOpenSettings: ((target: string) => void) | undefined;
}) {
  const link = settingsTarget && onOpenSettings ? settingsTarget : null;
  if (!notice && !link) return null;
  return (
    <p className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground">
      {notice ? <span className="me-1">{notice}</span> : null}
      {link ? <InlineButton onClick={() => onOpenSettings?.(link)}>{settingsLabel}</InlineButton> : null}
    </p>
  );
}
