// Layout adapted from T3 Code (apps/web/src/components/settings/SettingsSidebarNav.tsx), MIT — see NOTICE.
import { SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { isEditableTarget, isInsidePopup } from "~/components/layout/keyboard";
import { Button } from "~/components/ui/button";
import { SidebarContent, SidebarHeader, SidebarInput, useSidebar } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { useAskSettings } from "~/state/mutations";
import { useSettings, useSettingsAskStatus } from "~/state/queries";
import { usePalette } from "~/state/ui";
import { settingsIndex, settingsLocation, type SettingsIndexEntry } from "./settingsIndex.logic";
import { SettingsAskRow, type AskState } from "./SettingsAskRow";
import { askEntries, initialActive, isSearchShortcut, moveResult, searchSettings } from "./settingsSearch.logic";

const ENTRIES = settingsIndex();
const ASK_ENTRIES = askEntries(ENTRIES);
const CLI_SETTING = ENTRIES.find((entry) => entry.id === "integrations.claude-code.cli-path");

/**
 * The settings list with a search box above it. While something is typed the results take the list's place: the
 * setting's title with "Group › Sub-section" beneath. Arrows move through them, Enter opens one, Esc clears the box.
 * `/` and Ctrl/Cmd+F focus it from anywhere on the page. The first option is the Ask: the typed question put to
 * Claude Code, which answers and names the setting to go to. It starts highlighted when the text reads as a question.
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
  const question = query.trim();
  const searching = question !== "";
  // The options are the Ask row, then the results: `active` counts both.
  const optionCount = results.length + 1;
  const settings = useSettings();
  const askStatus = useSettingsAskStatus(settings.data?.headlessReviewCli ?? null);
  const askMutation = useAskSettings();
  const askState: AskState = askMutation.isPending
    ? { kind: "pending" }
    : askMutation.data
      ? { kind: "done", result: askMutation.data }
      : askMutation.isError
        ? { kind: "done", result: { ok: false, error: askMutation.error.message } }
        : { kind: "idle" };
  const answered = askMutation.data?.ok ? askMutation.data : null;
  const askTarget = answered?.settingId ? (ENTRIES.find((entry) => entry.id === answered.settingId) ?? null) : null;
  // Until the check comes back the row is shown as available: a miss only shows when the question is asked.
  const askUnavailable = askStatus.data && !askStatus.data.available ? askStatus.data.reason : null;

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
    askMutation.reset();
    onOpen(entry);
  };

  const activateAsk = () => {
    if (askUnavailable !== null || askMutation.isPending) return;
    if (askTarget) choose(askTarget);
    // An answer that names no setting has nowhere to go; changing the question asks again.
    else if (!askMutation.data?.ok) askMutation.mutate({ question, entries: ASK_ENTRIES });
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
            aria-activedescendant={searching && active < optionCount ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setQuery(next);
              // The answer belongs to the question that was asked.
              askMutation.reset();
              setActive(initialActive(next, searchSettings(ENTRIES, next).length));
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => moveResult(current, event.key === "ArrowDown" ? 1 : -1, optionCount));
              } else if (event.key === "Enter") {
                if (!searching) return;
                event.preventDefault();
                if (active === 0) activateAsk();
                else if (results[active - 1]) choose(results[active - 1]!);
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
          <div ref={listRef} id={listId} role="listbox" aria-label="Settings search results" className="p-2">
            <SettingsAskRow
              id={`${listId}-0`}
              question={question}
              active={active === 0}
              unavailable={askUnavailable}
              state={askState}
              target={askTarget}
              onActivate={activateAsk}
              onHover={() => setActive(0)}
              onSetUp={() => CLI_SETTING && choose(CLI_SETTING)}
            />
            {results.length === 0 ? (
              <p role="status" className="px-2 py-3 text-sm text-sidebar-muted-foreground">
                No settings found
              </p>
            ) : (
              results.map((entry, index) => (
                // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the focused combobox input takes the keys
                <div
                  key={entry.id}
                  id={`${listId}-${index + 1}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index + 1 === active}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-1.5",
                    index + 1 === active
                      ? "bg-sidebar-row-active text-sidebar-foreground"
                      : "hover:bg-sidebar-row-hover",
                  )}
                  onMouseMove={() => setActive(index + 1)}
                  // The input keeps focus, so a click must not blur it before the pick lands.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(entry)}
                >
                  <div className="truncate text-sm font-medium text-sidebar-foreground">{entry.title}</div>
                  <div className="truncate text-xs text-sidebar-muted-foreground">{settingsLocation(entry)}</div>
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
