import {
  AUTOPILOT_ALL_RUNS,
  RETIRED_AUTOMATION_TITLES,
  RUN_DELETE_IDS_MAX,
  type AutopilotRun,
  type AutopilotRunFilter,
} from "@repo/contracts";
import { ListChecksIcon, SearchIcon, Trash2Icon } from "lucide-react";
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
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useDebouncedValue } from "~/hooks/useDebouncedValue";
import { useAutopilotRunHistory, useDeleteAutopilotRuns, useDeleteRunsPreview } from "~/state/autopilotRunHistory";
import { useAutopilotOverview, useBoard } from "~/state/queries";
import { automationTitle } from "./autopilot.logic";
import { cn } from "~/lib/utils";
import {
  deleteTitle,
  describeRunFilter,
  isNarrowed,
  keptText,
  RUN_OUTCOMES,
  RUN_RANGES,
  runHistoryFilter,
  runsOfPages,
  type RunHistorySearch,
  type RunRange,
} from "./runHistory.logic";
import { AskToFix } from "./AskAgentButtons";
import { RunHistoryRow } from "./RunHistoryRow";

const ALL_PROJECTS = "all";
const NO_SELECTION: ReadonlySet<string> = new Set();

/** What a delete dialog is about: the ticked runs, or every run the filters match. */
type DeleteTarget = { kind: "ids"; ids: string[] } | { kind: "filter" };

/**
 * Every run of an automation (or of all of them), newest first, loading more as you scroll, filtered by automation,
 * outcome, project and time and searchable. A row opens to what the run kept. Deleting is out of the way under Clean
 * up…: ticked runs, or all matching the filters; nothing ever deletes runs by itself. The filters live in the URL (the
 * automation in the path, the rest in `search`), so a page can be linked to and survives a reload.
 */
export function RunHistory({
  automation,
  search,
  onSearch,
  onAutomation,
}: {
  /** An automation's key, or `AUTOPILOT_ALL_RUNS`. */
  automation: string;
  search: RunHistorySearch;
  onSearch: (next: RunHistorySearch) => void;
  /** Shows another automation's runs (or every one's, with `AUTOPILOT_ALL_RUNS`), keeping the other filters. */
  onAutomation: (automation: string) => void;
}) {
  const overview = useAutopilotOverview();
  const board = useBoard();
  const projects = board.data?.projects.filter((p) => p.archivedAt === null) ?? [];
  const catalogue = overview.data?.automations ?? [];
  const title = automation === AUTOPILOT_ALL_RUNS ? null : automationTitle(catalogue, automation);

  // A preset's "last 7 days" is counted from when the filters last changed, so the list doesn't shift as the clock
  // moves.
  const [asOf, setAsOf] = useState(() => new Date());
  const changeSearch = (next: RunHistorySearch) => {
    setAsOf(new Date());
    onSearch(next);
  };
  const { project, range, since, until, outcome, q } = search;
  const filter = useMemo(
    () => runHistoryFilter(automation, { project, range, since, until, outcome, q }, asOf),
    [automation, project, range, since, until, outcome, q, asOf],
  );
  const history = useAutopilotRunHistory(filter);
  const runs = runsOfPages(history.data?.pages);

  const filterKey = JSON.stringify(filter);
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: filterKey,
    ids: NO_SELECTION,
  });
  const [selecting, setSelecting] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(NO_SELECTION);
  // Ticks belong to the list they were made in: another filter starts clean.
  const selected = selection.key === filterKey ? selection.ids : NO_SELECTION;
  const ticked = runs.filter((r) => selected.has(r.id)).map((r) => r.id);
  // One delete by id takes only so many; "everything matching" has no such limit.
  const full = ticked.length >= RUN_DELETE_IDS_MAX;
  const setTicked = (ids: ReadonlySet<string>) => setSelection({ key: filterKey, ids });
  const [target, setTarget] = useState<DeleteTarget | null>(null);

  const taskNumbers = useMemo(() => new Map(board.data?.tasks.map((t) => [t.id, t.number]) ?? []), [board.data?.tasks]);
  const projectTitle = (id: string | null) => projects.find((p) => p.id === id)?.title ?? null;
  const automationItems = [
    { value: AUTOPILOT_ALL_RUNS, label: "All automations" },
    ...catalogue.map((a) => ({ value: a.key, label: a.title })),
    // Retired ones still have runs worth finding, under their old names.
    ...Object.entries(RETIRED_AUTOMATION_TITLES)
      .filter(([key]) => !catalogue.some((a) => a.key === key))
      .map(([key, label]) => ({ value: key, label: `${label} (retired)` })),
  ];
  if (!automationItems.some((i) => i.value === automation)) {
    automationItems.push({ value: automation, label: automationTitle(catalogue, automation) });
  }

  return (
    <div className="flex flex-col gap-3 px-3 sm:px-4">
      <p className="max-w-xl text-xs text-muted-foreground">
        {title ? `Every ${title} run` : "Every run of every automation"}, newest first. Open a run for its output,
        handover and thread.
      </p>

      <FilterBar
        search={search}
        projects={projects}
        automation={automation}
        automations={automationItems}
        onAutomation={onAutomation}
        onSearch={changeSearch}
      />

      {selecting ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              aria-label="Select all loaded runs"
              className="size-3.5 cursor-pointer accent-primary"
              checked={runs.length > 0 && ticked.length === Math.min(runs.length, RUN_DELETE_IDS_MAX)}
              ref={(el) => {
                if (el) {
                  el.indeterminate = ticked.length > 0 && ticked.length < Math.min(runs.length, RUN_DELETE_IDS_MAX);
                }
              }}
              disabled={runs.length === 0}
              onChange={(event) =>
                setTicked(
                  event.currentTarget.checked
                    ? new Set(runs.slice(0, RUN_DELETE_IDS_MAX).map((r) => r.id))
                    : NO_SELECTION,
                )
              }
            />
            {full
              ? `${ticked.length} selected, the most one delete takes`
              : ticked.length > 0
                ? `${ticked.length} selected`
                : "Select all loaded"}
          </label>
          <div className="ms-auto flex items-center gap-2">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={ticked.length === 0}
              onClick={() => setTarget({ kind: "ids", ids: ticked })}
            >
              <Trash2Icon />
              Delete selected
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setSelecting(false);
                setTicked(NO_SELECTION);
              }}
            >
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <RunList
        runs={runs}
        loading={history.isPending}
        error={history.error?.message ?? null}
        narrowed={isNarrowed(search)}
        automationTitles={catalogue}
        paused={new Set(overview.data?.autoPaused.map((p) => `${p.automation}:${p.projectId}`) ?? [])}
        selecting={selecting}
        selected={selected}
        selectionFull={full}
        onTick={(id, on) => {
          const next = new Set(selected);
          if (on) next.add(id);
          else next.delete(id);
          setTicked(next);
        }}
        opened={opened}
        onOpen={(id, open) => {
          const next = new Set(opened);
          if (open) next.add(id);
          else next.delete(id);
          setOpened(next);
        }}
        projectTitle={projectTitle}
        taskNumber={(id) => (id ? (taskNumbers.get(id) ?? null) : null)}
        hasMore={history.hasNextPage}
        loadingMore={history.isFetchingNextPage}
        onLoadMore={() => void history.fetchNextPage()}
        cleanUp={
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost-muted" disabled={runs.length === 0} />}>
              Clean up…
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setSelecting(true)}>
                <ListChecksIcon />
                Select runs to delete
              </MenuItem>
              <MenuItem variant="destructive" onClick={() => setTarget({ kind: "filter" })}>
                <Trash2Icon />
                {isNarrowed(search) || title ? "Delete all matching…" : "Delete all…"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
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
  automation,
  automations,
  onAutomation,
  onSearch,
}: {
  search: RunHistorySearch;
  projects: ReadonlyArray<{ id: string; title: string }>;
  automation: string;
  automations: ReadonlyArray<{ value: string; label: string }>;
  onAutomation: (automation: string) => void;
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search runs"
            size="sm"
            className="ps-8"
            placeholder="Search: #12, summary, run id"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </div>
        <Select
          items={automations}
          value={automation}
          onValueChange={(value) => {
            if (value !== null && value !== automation) onAutomation(value);
          }}
        >
          <SelectTrigger size="sm" className="sm:w-48" aria-label="Automation">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {automations.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
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
      <div role="group" aria-label="Outcome" className="flex flex-wrap items-center gap-1.5">
        {[{ value: undefined, label: "Any outcome" }, ...RUN_OUTCOMES].map((item) => (
          <button
            key={item.label}
            type="button"
            aria-pressed={search.outcome === item.value}
            className={cn(
              "cursor-pointer rounded-full border px-2.5 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              search.outcome === item.value
                ? "border-foreground/30 bg-accent text-foreground"
                : "border-border/60 text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onSearch({ ...search, outcome: item.value })}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RunList({
  runs,
  loading,
  error,
  narrowed,
  automationTitles,
  paused,
  selecting,
  selected,
  selectionFull,
  onTick,
  opened,
  onOpen,
  projectTitle,
  taskNumber,
  hasMore,
  loadingMore,
  onLoadMore,
  cleanUp,
}: {
  runs: AutopilotRun[];
  loading: boolean;
  error: string | null;
  narrowed: boolean;
  automationTitles: ReadonlyArray<{ key: string; title: string }>;
  /** `automation:projectId` of each auto-pause. */
  paused: ReadonlySet<string>;
  selecting: boolean;
  selected: ReadonlySet<string>;
  /** Nothing more can be ticked. */
  selectionFull: boolean;
  onTick: (id: string, on: boolean) => void;
  opened: ReadonlySet<string>;
  onOpen: (id: string, open: boolean) => void;
  projectTitle: (id: string | null) => string | null;
  taskNumber: (id: string | null) => number | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** The Clean up… menu, under the list. */
  cleanUp: React.ReactNode;
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

  // A failed refetch or next page keeps what is loaded, and says so above it.
  if (error && runs.length === 0) return <p className="text-xs text-destructive-foreground">{error}</p>;
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
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <SettingsGroup>
        <ul className="flex flex-col divide-y divide-border/50">
          {runs.map((run) => (
            <RunHistoryRow
              key={run.id}
              run={run}
              others={runs}
              automation={automationTitle(automationTitles, run.automation)}
              projectTitle={projectTitle(run.projectId)}
              taskNumber={taskNumber(run.taskId)}
              open={opened.has(run.id)}
              paused={paused.has(`${run.automation}:${run.projectId}`)}
              onOpenChange={(open) => onOpen(run.id, open)}
              selecting={selecting}
              checked={selected.has(run.id)}
              disabled={selectionFull && !selected.has(run.id)}
              onCheckedChange={(on) => onTick(run.id, on)}
              action={
                run.status === "failed" && !run.dryRun ? (
                  <AskToFix
                    run={run}
                    automationTitle={automationTitle(automationTitles, run.automation)}
                    task={taskNumber(run.taskId) === null ? null : `#${taskNumber(run.taskId)}`}
                    variant="outline"
                  />
                ) : undefined
              }
            />
          ))}
        </ul>
      </SettingsGroup>
      <div className="flex min-h-8 items-center gap-2 text-xs text-muted-foreground">
        <div ref={watchEnd} className="flex flex-1 items-center">
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
        {cleanUp}
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
              <p className="text-muted-foreground">
                Runs aren't part of backups, so this can't be undone, and the Stats page and digests count runs, so
                deleting them changes those too.
              </p>
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
