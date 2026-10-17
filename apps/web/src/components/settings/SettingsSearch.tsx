// Layout adapted from T3 Code (apps/web/src/components/settings/SettingsSidebarNav.tsx), MIT — see NOTICE.
import { SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { isEditableTarget, isInsidePopup } from "~/components/layout/keyboard";
import { Button } from "~/components/ui/button";
import { SidebarContent, SidebarHeader, SidebarInput, useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { usePalette } from "~/state/ui";
import { settingsIndex, settingsLocation, type SettingsIndexEntry } from "./settingsIndex.logic";
import { isSearchShortcut, moveResult, searchSettings } from "./settingsSearch.logic";

const ENTRIES = settingsIndex();

/**
 * The settings list with a search box above it. While something is typed the results take the list's place: the
 * setting's title with "Group › Sub-section" beneath. Arrows move through them, Enter opens one, Esc clears the box.
 * `/` and Ctrl/Cmd+F focus it from anywhere on the page.
 */
export function SettingsSearch({
  onOpen,
  children,
}: {
  onOpen: (entry: SettingsIndexEntry) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { open, setOpen } = useSidebar();
  const results = useMemo(() => searchSettings(ENTRIES, query), [query]);
  const searching = query.trim() !== "";

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (event.isComposing || !isSearchShortcut(event)) return;
    // Ctrl/Cmd+F works from a text field too (it is the browser's find otherwise); a typed "/" must not be taken.
    if (event.key === "/" && isEditableTarget(event.target)) return;
    if (isInsidePopup(event.target) || usePalette.getState().open) return;
    // On a narrow window with the sheet closed the box isn't mounted: leave the browser's find alone.
    if (!inputRef.current) return;
    event.preventDefault();
    if (!open) setOpen(true);
    // A hidden sidebar has no input to focus until it has rendered open.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (entry: SettingsIndexEntry) => {
    setQuery("");
    onOpen(entry);
  };

  return (
    <>
      <SidebarHeader className="pb-0">
        <div className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground focus-within:bg-sidebar-row-hover hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
          <SearchIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={inputRef}
            nativeInput
            type="search"
            role="combobox"
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
                const entry = results[active];
                if (!entry) return;
                event.preventDefault();
                choose(entry);
              } else if (event.key === "Escape") {
                event.preventDefault();
                if (query) setQuery("");
                else event.currentTarget.blur();
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
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
          ) : null}
        </div>
      </SidebarHeader>
      {searching ? (
        <SidebarContent>
          {results.length === 0 ? (
            <p role="status" className="px-4 py-3 text-sm text-sidebar-muted-foreground">
              No settings found
            </p>
          ) : (
            <div ref={listRef} id={listId} role="listbox" aria-label="Settings search results" className="p-2">
              {results.map((entry, index) => (
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
                  <div className="truncate text-sm font-medium text-sidebar-foreground">{entry.title}</div>
                  <div className="truncate text-xs text-sidebar-muted-foreground">{settingsLocation(entry)}</div>
                </div>
              ))}
            </div>
          )}
        </SidebarContent>
      ) : (
        children
      )}
    </>
  );
}
