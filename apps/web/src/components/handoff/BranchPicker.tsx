import type { T3LaunchOptions } from "@repo/contracts";
import { ChevronDownIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import {
  pickPinnedRef,
  pinnedRefRows,
  refLabel,
  refRows,
  selectedRef,
  type BranchRow,
  type PinnedBranchRow,
  type WorkspaceChoice,
} from "./handoff.logic";
import { ComposerControl } from "./T3LaunchPickers";

/**
 * The hand-off dialogs' searchable branch picker, modelled on T3 Code's BranchToolbar. The task's own branches are
 * pinned in a "This task" group above the full list, with where the board found each; the search filters both.
 */
export function BranchPicker({
  label,
  disabled,
  pinned,
  rows,
  selected,
  onPick,
  onPickPinned,
  footer,
}: {
  label: string;
  disabled: boolean;
  pinned: readonly PinnedBranchRow[];
  rows: readonly BranchRow[];
  /** The value of the picked row, marked in both groups. */
  selected: string | null;
  onPick: (value: string) => void;
  onPickPinned: (value: string) => void;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = <T extends BranchRow>(list: readonly T[]) =>
    list.filter((r) => !q || r.name.toLowerCase().includes(q));
  const pinnedShown = matches(pinned);
  const shown = matches(rows);
  const pick = (handler: (value: string) => void, value: string) => {
    handler(value);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger render={<ComposerControl size="xs" aria-label="Branch" disabled={disabled} />}>
        <GitBranchIcon />
        <span className="max-w-56 truncate">{label}</span>
        <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup align="end" padding="none" className="before:hidden">
        <div className="flex max-h-96 w-screen max-w-80 flex-col overflow-hidden p-1.5">
          <label className="mx-1 mb-1 flex items-center gap-2 border-b border-border px-1 pb-2 text-sm focus-within:border-primary">
            <SearchIcon aria-hidden className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search refs..."
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {pinnedShown.length > 0 ? (
              <div role="group" aria-label="This task">
                <GroupLabel count={pinnedShown.length}>This task</GroupLabel>
                {pinnedShown.map((row) => (
                  <Row
                    key={`pinned:${row.value}`}
                    row={row}
                    selected={row.value === selected}
                    onClick={() => pick(onPickPinned, row.value)}
                  >
                    <span className="col-span-2 flex flex-wrap gap-1">
                      {row.sources.map((source) => (
                        <Badge
                          key={source.label}
                          size="sm"
                          variant={source.kind === "pr" && !source.inactive ? "success" : "secondary"}
                          className="font-normal"
                        >
                          {source.label}
                        </Badge>
                      ))}
                    </span>
                  </Row>
                ))}
                <div className="mx-1 my-1.5 h-px bg-border" />
                <GroupLabel>All refs</GroupLabel>
              </div>
            ) : null}
            {shown.map((row) => (
              <Row
                key={row.value}
                row={row}
                selected={row.value === selected}
                onClick={() => pick(onPick, row.value)}
              />
            ))}
            {shown.length === 0 && pinnedShown.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">No refs found</p>
            ) : null}
          </div>
          {footer ? (
            <p className="border-t border-border/70 px-2 pt-2 pb-1 text-xs leading-snug text-muted-foreground">
              {footer}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function GroupLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex justify-between px-2 pt-1.5 pb-1 text-[.6875rem] font-medium tracking-wide text-muted-foreground/70 uppercase">
      <span>{children}</span>
      {count !== undefined ? <span>{count}</span> : null}
    </div>
  );
}

function Row({
  row,
  selected,
  onClick,
  children,
}: {
  row: BranchRow & { inactive?: boolean };
  selected: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={row.disabledReason !== null}
      title={row.disabledReason ?? undefined}
      aria-current={selected || undefined}
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-45 aria-current:bg-accent/60",
        row.inactive && "opacity-60",
      )}
    >
      <span className="truncate">{row.name}</span>
      {row.badge ? <span className="text-xs text-muted-foreground/70">{row.badge}</span> : <span />}
      {children}
    </button>
  );
}

/** The T3 dialog's branch picker: T3's refs, with the task's branches pinned. */
export function RefPicker({
  options,
  choice,
  onChange,
}: {
  options: T3LaunchOptions;
  choice: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
}) {
  return (
    <BranchPicker
      label={options.isRepo ? refLabel(options, choice) : "Not a git repository"}
      disabled={!options.isRepo || choice.mode === "previous"}
      pinned={pinnedRefRows(options, choice)}
      rows={refRows(options, choice)}
      selected={selectedRef(options, choice)?.name ?? null}
      onPick={(ref) => onChange({ ...choice, ref })}
      onPickPinned={(ref) => onChange(pickPinnedRef(options, choice, ref))}
      footer={choice.mode === "current" ? "Other branches need a checkout. Pick New worktree to start from one." : null}
    />
  );
}
