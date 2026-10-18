import { AUTOPILOT_ALL_RUNS, type AutopilotRun, type AutopilotRunFilter } from "@repo/contracts";
import { ChevronLeftIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { SettingsGroup } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useDebouncedValue } from "~/hooks/useDebouncedValue";
import { useAutopilotRunHistory, useDeleteAutopilotRuns, useDeleteRunsPreview } from "~/state/autopilotRunHistory";
import { useAutopilotOverview, useBoard } from "~/state/queries";
import { automationTitle } from "./autopilot.logic";
import {
  deleteTitle,
  describeRunFilter,
  isNarrowed,
  keptText,
  RUN_RANGES,
  runHistoryFilter,
  runsOfPages,
  type RunHistorySearch,
  type RunRange,
} from "./runHistory.logic";
import { RunHistoryRow } from "./RunHistoryRow";

const ALL_PROJECTS = "all";
const NO_SELECTION: ReadonlySet<string> = new Set();

/** What a delete dialog is about: the ticked runs, or every run the filters match. */
type DeleteTarget = { kind: "ids"; ids: string[] } | { kind: "filter" };

/**
 * Every run of an automation (or of all of them), newest first, loading more as you scroll, filtered by project and
 * time and searchable. Runs can be deleted by hand, ticked or all matching the filters: nothing ever deletes them by
 * itself. The filters live in the URL (`search`), so a page can be linked to and survives a reload.
 */
export function RunHistory({
  automation,
  search,
  onSearch,
  onBack,
}: {
  /** An automation's key, or `AUTOPILOT_ALL_RUNS`. */
  automation: string;
  search: RunHistorySearch;
  onSearch: (next: RunHistorySearch) => void;
  onBack: () => void;
}) {
  const overview = useAutopilotOverview();
  const board = useBoard();
  const projects = board.data?.projects.filter((p) => p.archivedAt === null) ?? [];
  const title =
    automation === AUTOPILOT_ALL_RUNS ? null : automationTitle(overview.data?.automations ?? [], automation);

  // A preset's "last 7 days" is counted from when the filters last changed, so the list doesn't shift as the clock
  // moves.
  const [asOf, setAsOf] = useState(() => new Date());
  const changeSearch = (next: RunHistorySearch) => {
    setAsOf(new Date());
    onSearch(next);
  };
  const { project, range, since, until, q } = search;
  const filter = useMemo(
    () => runHistoryFilter(automation, { project, range, since, until, q }, asOf),
    [automation, project, range, since, until, q, asOf],
  );
  const history = useAutopilotRunHistory(filter);
  const runs = runsOfPages(history.data?.pages);

  const filterKey = JSON.stringify(filter);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: filterKey,
    ids: NO_SELECTION,
  });
  // Ticks belong to the list they were made in: another filter starts clean.
  const selected = selection.key === filterKey ? selection.ids : NO_SELECTION;
  const ticked = runs.filter((r) => selected.has(r.id)).map((r) => r.id);
  const setTicked = (ids: ReadonlySet<string>) => setSelection({ key: filterKey, ids });
  const [target, setTarget] = useState<DeleteTarget | null>(null);

  const taskNumbers = useMemo(() => new Map(board.data?.tasks.map((t) => [t.id, t.number]) ?? []), [board.data?.tasks]);
  const projectTitle = (id: string | null) => projects.find((p) => p.id === id)?.title ?? null;

  return (
    <div className="flex flex-col gap-4 px-3 sm:px-4">
      <div className="flex flex-col gap-2">
        <Button variant="ghost-muted" size="sm" className="-ms-2 w-fit" onClick={onBack}>
          <ChevronLeftIcon />
          Autopilot settings
        </Button>
        <h1 className="font-semibold text-xl leading-none">Run history{title ? `: ${title}` : ""}</h1>
        <p className="max-w-xl text-xs text-muted-foreground">
          {title ? `Every ${title} run` : "Every run of every automation"}, newest first. Runs are only deleted when you
          delete them here.
        </p>
      </div>

      <FilterBar search={search} projects={projects} onSearch={changeSearch} />

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            aria-label="Select all loaded runs"
            className="size-3.5 cursor-pointer accent-primary"
            checked={runs.length > 0 && ticked.length === runs.length}
            ref={(el) => {
              if (el) el.indeterminate = ticked.length > 0 && ticked.length < runs.length;
            }}
            disabled={runs.length === 0}
            onChange={(event) => setTicked(event.currentTarget.checked ? new Set(runs.map((r) => r.id)) : NO_SELECTION)}
          />
          {ticked.length > 0 ? `${ticked.length} selected` : "Select all loaded"}
        </label>
        <div className="ms-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={ticked.length === 0}
            onClick={() => setTarget({ kind: "ids", ids: ticked })}
          >
            <Trash2Icon />
            Delete selected
          </Button>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={runs.length === 0}
            onClick={() => setTarget({ kind: "filter" })}
          >
            <Trash2Icon />
            {isNarrowed(search) ? "Delete all matching…" : "Delete all…"}
          </Button>
        </div>
      </div>

      <RunList
        runs={runs}
        loading={history.isPending}
        error={history.error?.message ?? null}
        narrowed={isNarrowed(search)}
        showAutomation={automation === AUTOPILOT_ALL_RUNS}
        automationTitles={overview.data?.automations ?? []}
        selected={selected}
        onTick={(id, on) => {
          const next = new Set(selected);
          if (on) next.add(id);
          else next.delete(id);
          setTicked(next);
        }}
        projectTitle={projectTitle}
        taskNumber={(id) => (id ? (taskNumbers.get(id) ?? null) : null)}
        hasMore={history.hasNextPage}
        loadingMore={history.isFetchingNextPage}
        onLoadMore={() => void history.fetchNextPage()}
      />

      <DeleteDialog
        target={target}
        filter={filter}
        description={describeRunFilter(title, projectTitle(project ?? null), search)}
        onClose={() => setTarget(null)}
        onDeleted={() => setTicked(NO_SELECTION)}
      />
    </div>
  );
}

function FilterBar({
  search,
  projects,
  onSearch,
}: {
  search: RunHistorySearch;
  projects: ReadonlyArray<{ id: string; title: string }>;
  onSearch: (next: RunHistorySearch) => void;
}) {
  // The box keeps what is typed; the URL, and so the query, follows once typing pauses.
  const [text, setText] = useState(search.q ?? "");
  const typed = useDebouncedValue(text, 300);
  useEffect(() => {
    const next = typed.trim() === "" ? undefined : typed;
    if (next !== search.q) onSearch({ ...search, q: next });
  }, [typed, search, onSearch]);

  const projectItems = [
    { value: ALL_PROJECTS, label: "All projects" },
    ...projects.map((p) => ({ value: p.id, label: p.title })),
  ];
  const range: RunRange = search.range ?? "all";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-48 flex-1">
        <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search runs"
          size="sm"
          className="ps-8"
          placeholder="Search run id, project, #12, summary or handover"
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </div>
      <Select
        items={projectItems}
        value={search.project ?? ALL_PROJECTS}
        onValueChange={(value) => {
          if (value !== null) onSearch({ ...search, project: value === ALL_PROJECTS ? undefined : value });
        }}
      >
        <SelectTrigger size="sm" className="sm:w-44" aria-label="Project">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {projectItems.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select
        items={RUN_RANGES}
        value={range}
        onValueChange={(value) => {
          if (value === null) return;
          const next = value === "all" ? undefined : value;
          // Days only mean something in a custom range; leaving it forgets them.
          onSearch({ ...search, range: next, ...(next === "custom" ? {} : { since: undefined, until: undefined }) });
        }}
      >
        <SelectTrigger size="sm" className="sm:w-40" aria-label="Time">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {RUN_RANGES.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {search.range === "custom" ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Input
            type="date"
            aria-label="From"
            size="sm"
            className="w-36"
            value={search.since ?? ""}
            max={search.until}
            onChange={(event) => onSearch({ ...search, since: event.currentTarget.value || undefined })}
          />
          to
          <Input
            type="date"
            aria-label="Until (included)"
            size="sm"
            className="w-36"
            value={search.until ?? ""}
            min={search.since}
            onChange={(event) => onSearch({ ...search, until: event.currentTarget.value || undefined })}
          />
        </div>
      ) : null}
    </div>
  );
}

function RunList({
  runs,
  loading,
  error,
  narrowed,
  showAutomation,
  automationTitles,
  selected,
  onTick,
  projectTitle,
  taskNumber,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  runs: AutopilotRun[];
  loading: boolean;
  error: string | null;
  narrowed: boolean;
  showAutomation: boolean;
  automationTitles: ReadonlyArray<{ key: string; title: string }>;
  selected: ReadonlySet<string>;
  onTick: (id: string, on: boolean) => void;
  projectTitle: (id: string | null) => string | null;
  taskNumber: (id: string | null) => number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  // Loads the next page when the end of the list comes near. A ref callback that is new on each render, so the end
  // is observed again after every page: one that doesn't fill the screen goes on to the next.
  const watchEnd = (el: HTMLDivElement | null) => {
    if (!el || !hasMore || loadingMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  };

  if (error) return <p className="text-xs text-destructive-foreground">{error}</p>;
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" /> Loading runs...
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border/60 px-4 py-8 text-center text-xs text-muted-foreground">
        {narrowed ? "No runs match these filters." : "No runs yet."}
      </p>
    );
  }
  return (
    <>
      <SettingsGroup>
        <ul className="flex flex-col divide-y divide-border/50">
          {runs.map((run) => (
            <RunHistoryRow
              key={run.id}
              run={run}
              automation={showAutomation ? automationTitle(automationTitles, run.automation) : null}
              projectTitle={projectTitle(run.projectId)}
              taskNumber={taskNumber(run.taskId)}
              checked={selected.has(run.id)}
              onCheckedChange={(on) => onTick(run.id, on)}
            />
          ))}
        </ul>
      </SettingsGroup>
      <div ref={watchEnd} className="flex min-h-8 items-center justify-center text-xs text-muted-foreground">
        {hasMore ? (
          loadingMore ? (
            <Spinner className="size-3.5" />
          ) : (
            <Button size="sm" variant="ghost-muted" onClick={onLoadMore}>
              Load more
            </Button>
          )
        ) : (
          `${runs.length} run${runs.length === 1 ? "" : "s"}`
        )}
      </div>
    </>
  );
}

/**
 * Asks the server what a delete would do (it keeps the runs Autopilot still reads), says so, and deletes on confirm.
 * Runs aren't in backups, so there is no way back.
 */
function DeleteDialog({
  target,
  filter,
  description,
  onClose,
  onDeleted,
}: {
  target: DeleteTarget | null;
  filter: AutopilotRunFilter;
  description: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const input = target === null ? null : target.kind === "ids" ? { ids: target.ids } : { filter };
  const preview = useDeleteRunsPreview(input);
  const remove = useDeleteAutopilotRuns();
  const result = preview.data;
  const confirm = () => {
    if (!input) return;
    remove.mutate(input, {
      onSuccess: ({ deleted, kept }) => {
        toastManager.add({
          type: "success",
          title: deleted === 1 ? "Deleted 1 run" : `Deleted ${deleted} runs`,
          description: kept > 0 ? `${kept} kept: Autopilot still reads them.` : undefined,
        });
        onDeleted();
        onClose();
      },
    });
  };
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{result ? deleteTitle(result.deleted) : "Delete runs?"}</DialogTitle>
          <DialogDescription>
            {target?.kind === "ids"
              ? `${target.ids.length} selected run${target.ids.length === 1 ? "" : "s"}.`
              : `${description}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-2 text-sm">
          {preview.error ? (
            <p className="text-destructive-foreground">{preview.error.message}</p>
          ) : !result ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner className="size-3.5" /> Counting...
            </p>
          ) : (
            <>
              <p>
                {result.deleted === 0
                  ? "Nothing here can be deleted."
                  : `${result.deleted} run${result.deleted === 1 ? "" : "s"} will be deleted.`}
              </p>
              {result.kept > 0 ? (
                <p className="text-muted-foreground">
                  {`${result.kept} will be kept, since Autopilot still reads them: ${keptText(result)}.`}
                </p>
              ) : null}
              <p className="text-muted-foreground">Runs aren't part of backups, so this can't be undone.</p>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={remove.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!result || result.deleted === 0 || remove.isPending}
            onClick={confirm}
          >
            {remove.isPending ? <Spinner /> : <Trash2Icon />}
            {result ? deleteTitle(result.deleted).replace("?", "") : "Delete"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
