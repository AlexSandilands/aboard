// Adapted from T3 Code (apps/web/src/components/settings/ThemeSearchSection.tsx), MIT — see NOTICE. Searching Open
// VSX for colour theme extensions and installing one as a collection of themes.
import { ExternalLinkIcon, PackagePlusIcon, PaletteIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { customThemeLibrary } from "~/hooks/useTheme";
import {
  importOpenVsxThemeExtension,
  type OpenVsxThemeExtension,
  type OpenVsxThemeSort,
  searchOpenVsxThemes,
} from "~/theme/openVsxThemes";
import type { ThemeDefinition } from "~/theme/palettes";

const DOWNLOAD_FORMAT = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const SUGGESTED_SEARCHES = ["Dracula", "Catppuccin", "Nord", "Tokyo Night"];
const SORT_OPTIONS: ReadonlyArray<{ value: OpenVsxThemeSort; label: string }> = [
  { value: "downloadCount", label: "Most downloaded" },
  { value: "rating", label: "Best rated" },
  { value: "timestamp", label: "Newest" },
  { value: "relevance", label: "Most relevant" },
];
const SEARCH_DEBOUNCE_MS = 350;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function ThemeExtensionIcon({ extension }: { extension: OpenVsxThemeExtension }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
      {extension.iconUrl && !failed ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={extension.iconUrl}
          onError={() => setFailed(true)}
        />
      ) : (
        <PaletteIcon className="size-4" />
      )}
    </div>
  );
}

/** Mounted only while the Add theme dialog is open, so every open starts with an empty search. */
export function ThemeSearchSection({
  onInstalled,
}: {
  onInstalled: (themes: ReadonlyArray<ThemeDefinition>, context: { updated: boolean }) => void;
}) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<OpenVsxThemeSort>("downloadCount");
  const [results, setResults] = useState<ReadonlyArray<OpenVsxThemeExtension> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<OpenVsxThemeExtension | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  // Recorded only once a search succeeds, so a finished install reruns the search only when the query or sort changed
  // while it was in flight, and the install error the user needs to see survives.
  const [lastSearchKey, setLastSearchKey] = useState<string | null>(null);
  const [handledSearch, setHandledSearch] = useState<{ key: string; query: string; fetch: boolean } | null>(null);
  // An install aborts any search, so once it ends the current key is checked again even though it hasn't changed.
  const [searchInterrupted, setSearchInterrupted] = useState(false);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [],
  );

  const queryCleared = !query.trim() && installingId === null;
  if (
    queryCleared &&
    (results !== null || error !== null || isSearching || lastSearchKey !== null || handledSearch !== null)
  ) {
    setResults(null);
    setError(null);
    setIsSearching(false);
    setLastSearchKey(null);
    setHandledSearch(null);
  }

  useEffect(() => {
    if (!queryCleared) return;
    requestRef.current?.abort();
    requestRef.current = null;
  }, [queryCleared]);

  const startRequest = () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    return controller;
  };

  const fetchResults = async (trimmed: string, controller: AbortController) => {
    const key = `${trimmed}\u0000${sortBy}`;
    try {
      const nextResults = await searchOpenVsxThemes(trimmed, { signal: controller.signal, sortBy });
      if (!controller.signal.aborted) {
        setResults(nextResults);
        setLastSearchKey(key);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setResults(null);
        setLastSearchKey(null);
        setError(cause instanceof Error ? cause.message : "Open VSX search failed.");
      }
    }
    if (requestRef.current !== controller) return;
    requestRef.current = null;
    setIsSearching(false);
  };

  const runSearch = (searchText: string) => {
    const trimmed = searchText.trim();
    if (!trimmed) return;
    setError(null);
    setIsSearching(true);
    void fetchResults(trimmed, startRequest());
  };

  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
  const searchKey = `${debouncedQuery}\u0000${sortBy}`;
  // An unsettled query would hit Open VSX for text that is no longer visible; wait for the debounce to catch up.
  const searchSettled = installingId === null && debouncedQuery !== "" && debouncedQuery === query.trim();

  const keyChanged = handledSearch?.key !== searchKey;
  if (searchSettled && (keyChanged || searchInterrupted)) {
    // Typing and then undoing lands back on the key already shown; keep those results instead of searching again.
    const fetch = lastSearchKey !== searchKey;
    setHandledSearch({ key: searchKey, query: debouncedQuery, fetch });
    setSearchInterrupted(false);
    // An install error on an unchanged, already-shown query stays visible.
    if (fetch || keyChanged) setError(null);
    setIsSearching(fetch);
  }

  const fetchHandledSearch = useEffectEvent((searchText: string) => void fetchResults(searchText, startRequest()));

  useEffect(() => {
    if (!handledSearch) return;
    if (handledSearch.fetch) {
      // oxlint-disable-next-line react/set-state-in-effect -- the request's state is set once it settles, after an await
      fetchHandledSearch(handledSearch.query);
      return;
    }
    // A request for a newer key may still be in flight; abort it so it can't overwrite the results being kept.
    requestRef.current?.abort();
    requestRef.current = null;
  }, [handledSearch]);

  const handleInstall = async (extension: OpenVsxThemeExtension, allowUpdate: boolean) => {
    setError(null);
    let installed: ReadonlyArray<ThemeDefinition>;
    try {
      installed = customThemeLibrary.collection(extension.collectionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Installed themes could not be read.");
      return;
    }
    const updated = installed.length > 0;
    if (updated && !allowUpdate) {
      setPendingUpdate(extension);
      return;
    }

    const controller = startRequest();
    setIsSearching(false);
    setSearchInterrupted(true);
    setInstallingId(extension.id);
    try {
      const themes = await importOpenVsxThemeExtension(extension, controller.signal);
      if (!controller.signal.aborted) {
        onInstalled(customThemeLibrary.replaceCollection(extension.collectionId, themes, installed), { updated });
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "That theme could not be added.");
    }
    if (requestRef.current === controller) {
      requestRef.current = null;
      setInstallingId(null);
    }
  };

  const installedCollections = new Set(
    customThemeLibrary.themes().flatMap((theme) => (theme.collection ? [theme.collection.id] : [])),
  );

  return (
    <section className="space-y-3" aria-labelledby="theme-search-heading">
      <div>
        <h3 className="text-sm font-medium" id="theme-search-heading">
          Search community themes
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Find open-source themes from Open VSX.</p>
      </div>
      <InputGroup>
        <InputGroupAddon>{isSearching ? <Spinner aria-hidden /> : <SearchIcon aria-hidden />}</InputGroupAddon>
        <InputGroupInput
          aria-label="Search Open VSX themes"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- searching is what the dialog opens for, as in T3 Code
          autoFocus
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && !isSearching && installingId === null) runSearch(query.trim());
          }}
          placeholder="Search themes..."
          size="lg"
          type="search"
          value={query}
        />
      </InputGroup>

      {!isSearching || results !== null ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <p className="text-xs text-muted-foreground">Popular</p>
            {SUGGESTED_SEARCHES.map((suggestion) => (
              <Button
                key={suggestion}
                disabled={installingId !== null}
                size="xs"
                variant="ghost"
                onClick={() => (query.trim() === suggestion ? runSearch(suggestion) : setQuery(suggestion))}
              >
                {suggestion}
              </Button>
            ))}
          </div>
          {results && results.length > 0 ? (
            <div className="flex shrink-0 items-center justify-end gap-2">
              <p className="text-xs text-muted-foreground">Sort</p>
              <Select
                disabled={installingId !== null}
                value={sortBy}
                onValueChange={(value) => {
                  const next = SORT_OPTIONS.find((option) => option.value === value)?.value;
                  if (next) setSortBy(next);
                }}
              >
                <SelectTrigger size="sm" className="w-40" aria-label="Sort themes">
                  <SelectValue>{SORT_OPTIONS.find((option) => option.value === sortBy)?.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} hideIndicator value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="sr-only" role="status">
        {isSearching
          ? "Searching themes..."
          : results
            ? `${results.length} supported ${results.length === 1 ? "theme" : "themes"} found.`
            : ""}
      </div>

      {error ? (
        <Alert variant="error" aria-live="polite">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isSearching && results === null ? (
        <div className="flex min-h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Searching themes...
        </div>
      ) : null}

      {results ? (
        results.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed text-center">
            <p className="text-sm font-medium">No supported open-source themes found</p>
            <p className="mt-1 text-xs text-muted-foreground">Try a broader search.</p>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {results.map((extension) => {
              const isInstalling = installingId === extension.id;
              const isInstalled = installedCollections.has(extension.collectionId);
              const action = isInstalled ? "Update" : "Install";
              const progressAction = isInstalled ? "Updating" : "Installing";
              return (
                <article
                  className="group flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card/60 p-3 transition-colors hover:bg-accent/20"
                  key={extension.id}
                >
                  <div className="flex min-w-0 gap-3">
                    <ThemeExtensionIcon key={extension.iconUrl} extension={extension} />
                    <div className="min-w-0 flex-1">
                      <h4 className="truncate text-sm font-medium">{extension.name}</h4>
                      <p className="truncate text-xs text-muted-foreground">
                        {extension.publisher} · {DOWNLOAD_FORMAT.format(extension.downloadCount)} downloads
                      </p>
                    </div>
                  </div>
                  <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                    {extension.description || "A community color theme for your editor."}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {extension.sourceUrl ? (
                        <Button
                          aria-label={`View source for ${extension.name}`}
                          render={
                            <a
                              aria-label={`View source for ${extension.name}`}
                              href={extension.sourceUrl}
                              rel="noreferrer"
                              target="_blank"
                            />
                          }
                          size="icon-micro"
                          variant="ghost-muted"
                        >
                          <ExternalLinkIcon className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                    <Button
                      aria-label={`${isInstalling ? progressAction : action} ${extension.name}`}
                      disabled={installingId !== null}
                      size="xs"
                      variant="outline"
                      onClick={() => void handleInstall(extension, false)}
                    >
                      {isInstalling ? <Spinner /> : isInstalled ? <RefreshCwIcon /> : <PackagePlusIcon />}
                      {isInstalling ? `${progressAction}...` : action}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )
      ) : null}

      <Dialog open={pendingUpdate !== null} onOpenChange={(open) => !open && setPendingUpdate(null)}>
        <DialogPopup showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Update “{pendingUpdate?.name}”?</DialogTitle>
            <DialogDescription>
              This replaces its installed variants, including any local edits. Variants no longer in the extension will
              be removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              onClick={() => {
                const extension = pendingUpdate;
                setPendingUpdate(null);
                if (extension) void handleInstall(extension, true);
              }}
            >
              Update theme
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
