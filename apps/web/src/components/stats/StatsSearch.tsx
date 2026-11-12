import type { StatsResponse } from "@repo/contracts";
import { SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { isEditableTarget, isInsidePopup } from "~/components/layout/keyboard";
import { isSearchShortcut, moveResult } from "~/components/settings/settingsSearch.logic";
import { Button } from "~/components/ui/button";
import { SidebarContent, SidebarHeader, SidebarInput, SidebarMenuButton } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { usePalette } from "~/state/ui";
import { searchStatsNav, type StatsSearchEntry } from "./statsNav.logic";

/**
 * The Stats rail's search box, built like Settings' (`SettingsSearch`) so the two windows feel the same, without its
 * Ask row. While something is typed the matching sections and cards take the list's place: the label with its section
 * beneath. Arrows move through them, Enter jumps to one, Esc clears the box. `/` and Ctrl/Cmd+F focus it. It is
 * disabled while the page draws no charts, as the list is.
 *
 * Below `md` the rail is a strip of icons with no room for the box: a search button stands in for it, and `expanded`
 * (the rail spread over the page) shows the box and the full list, until a pick, Esc in the empty box or its close
 * button.
 */
export function StatsSearch({
  data,
  disabled,
  onJump,
  expanded,
  onExpandedChange,
  children,
}: {
  data: StatsResponse | undefined;
  disabled: boolean;
  onJump: (id: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchStatsNav(data, query), [data, query]);
  const searching = !disabled && query.trim() !== "";

  const focusBox = () => {
    onExpandedChange(true);
    // In the icon rail the box is hidden until the rail has rendered expanded.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (disabled || event.isComposing || !isSearchShortcut(event)) return;
    // Ctrl/Cmd+F works from a text field too (it is the browser's find otherwise); a typed "/" must not be taken.
    if (event.key === "/" && isEditableTarget(event.target)) return;
    if (isInsidePopup(event.target) || usePalette.getState().open) return;
    event.preventDefault();
    focusBox();
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (entry: StatsSearchEntry) => {
    setQuery("");
    inputRef.current?.blur();
    onExpandedChange(false);
    onJump(entry.id);
  };

  return (
    <>
      <SidebarHeader className="pb-0">
        {expanded ? null : (
          <SidebarMenuButton
            aria-label="Search stats"
            title="Search stats"
            className="md:hidden"
            disabled={disabled}
            onClick={focusBox}
          >
            <SearchIcon />
          </SidebarMenuButton>
        )}
        <div
          className={cn(
            "flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground focus-within:bg-sidebar-row-hover",
            disabled ? "opacity-50" : "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            !expanded && "max-md:hidden",
          )}
        >
          <SearchIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={inputRef}
            nativeInput
            type="search"
            role="combobox"
            disabled={disabled}
            aria-expanded={searching}
            aria-controls={searching ? listId : undefined}
            aria-activedescendant={searching && results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => moveResult(current, event.key === "ArrowDown" ? 1 : -1, results.length));
              } else if (event.key === "Enter") {
                if (!searching) return;
                event.preventDefault();
                if (results[active]) choose(results[active]);
              } else if (event.key === "Escape") {
                // Prevented, so the window's `back` shortcut leaves it: Esc clears the box, then leaves it.
                event.preventDefault();
                if (query) setQuery("");
                else {
                  event.currentTarget.blur();
                  onExpandedChange(false);
                }
              }
            }}
            placeholder="Search stats"
            aria-label="Search stats"
            className="min-w-0 flex-1"
          />
          {query ? (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0 md:hidden"
              aria-label="Close search"
              onClick={() => onExpandedChange(false)}
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>
      </SidebarHeader>
      {searching ? (
        <SidebarContent>
          <div ref={listRef} id={listId} role="listbox" aria-label="Stats search results" className="p-2">
            {results.length === 0 ? (
              <p role="status" className="px-2 py-3 text-sm text-sidebar-muted-foreground">
                No charts found
              </p>
            ) : (
              results.map((entry, index) => (
                // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the focused combobox input takes the keys
                <div
                  key={entry.id}
                  id={`${listId}-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5",
                    index === active ? "bg-sidebar-row-active text-sidebar-foreground" : "hover:bg-sidebar-row-hover",
                  )}
                  onMouseMove={() => setActive(index)}
                  // The input keeps focus, so a click must not blur it before the pick lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(entry)}
                >
                  <div className="truncate text-sm font-medium text-sidebar-foreground">{entry.label}</div>
                  <div className="truncate text-xs text-sidebar-muted-foreground">{entry.location}</div>
                </div>
              ))
            )}
          </div>
        </SidebarContent>
      ) : (
        children
      )}
    </>
  );
}
