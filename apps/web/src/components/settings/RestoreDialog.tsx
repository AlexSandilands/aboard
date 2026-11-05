import {
  RESTORE_CONFIRM_WORD,
  type BackupCommit,
  type BackupDiff,
  type BackupMachine,
  type RestoreBoardInput,
  type RestoreBoardResult,
  type RestoreTasksResult,
} from "@repo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { api } from "~/lib/api";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { queryKeys } from "~/state/queries";

type Tab = "tasks" | "board";

const query = (params: Record<string, string>) => {
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  return search ? `?${search}` : "";
};

/** Restore from the git backup: tasks missing or changed since a commit, or the whole board as it was then. */
export function RestoreDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [machine, setMachine] = useState("");
  const [commit, setCommit] = useState("");
  const machines = useQuery({
    queryKey: ["backupMachines"],
    queryFn: ({ signal }) => api<BackupMachine[]>("/api/backup/machines", { signal }),
    enabled: open,
  });
  // This machine's folder until another is picked.
  const folder = machine || machines.data?.find((m) => m.current)?.folder || machines.data?.[0]?.folder || "";
  const history = useQuery({
    queryKey: ["backupHistory", folder],
    queryFn: ({ signal }) => api<BackupCommit[]>(`/api/backup/history${query({ machine: folder })}`, { signal }),
    enabled: open && folder !== "",
  });
  const sha = commit || history.data?.[0]?.commit || "";
  const diff = useQuery({
    queryKey: ["backupDiff", folder, sha],
    queryFn: ({ signal }) => api<BackupDiff>(`/api/backup/diff${query({ machine: folder, commit: sha })}`, { signal }),
    enabled: open && sha !== "",
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore from backup</DialogTitle>
          <DialogDescription>Pick a machine's folder and a backup commit, then what to bring back.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <Picker
              label="Machine"
              value={folder}
              items={(machines.data ?? []).map((m) => ({
                value: m.folder,
                label: m.current ? `${m.folder} (this machine)` : m.folder,
              }))}
              onChange={(next) => {
                setMachine(next);
                setCommit("");
              }}
            />
            <Picker
              label="Backup"
              value={sha}
              items={(history.data ?? []).map((c) => ({
                value: c.commit,
                label: `${c.shortCommit} · ${formatRelativeTimeLabel(c.committedAt)} · ${c.subject}`,
              }))}
              onChange={setCommit}
            />
          </div>
          {machines.error || history.error || diff.error ? (
            <p className="text-destructive-foreground">{(machines.error ?? history.error ?? diff.error)!.message}</p>
          ) : null}
          <ToggleGroup
            aria-label="What to restore"
            value={[tab]}
            onValueChange={(next) => {
              if (next[0] === "tasks" || next[0] === "board") setTab(next[0]);
            }}
          >
            <Toggle value="tasks">Tasks</Toggle>
            <Toggle value="board">Whole board</Toggle>
          </ToggleGroup>
          {tab === "tasks" ? (
            <TasksTab
              key={`${folder}:${sha}`}
              diff={diff.data}
              loading={diff.isFetching}
              source={{ machine: folder, commit: sha }}
            />
          ) : (
            <BoardTab
              key={`${folder}:${sha}`}
              diff={diff.data}
              source={{ machine: folder, commit: sha }}
              onDone={onClose}
            />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Picker({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Select items={items} value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

interface Source {
  machine: string;
  commit: string;
}

function TasksTab({ diff, loading, source }: { diff: BackupDiff | undefined; loading: boolean; source: Source }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const restore = useMutation({
    mutationFn: (numbers: number[]) =>
      api<RestoreTasksResult>("/api/backup/restore-tasks", {
        method: "POST",
        // Changed tasks are replaced: picking one is asking for the backup's version.
        body: { ...source, numbers, force: true },
      }),
  });
  if (loading && !diff) return <Spinner />;
  if (!diff) return null;
  if (diff.tasks.length === 0)
    return <p className="text-muted-foreground">Every task in this backup is on the board as it is.</p>;
  const results = new Map((restore.data?.results ?? []).map((r) => [r.number, r]));
  const toggle = (number: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(number);
      else next.delete(number);
      return next;
    });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground">
        {diff.counts.missing} missing from the board, {diff.counts.changed} changed since. A changed task is replaced by
        the backup's version.
      </p>
      <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
        {diff.tasks.map((task) => {
          const result = results.get(task.number);
          return (
            <li key={task.taskId} className="flex items-start gap-2.5 px-3 py-2 text-xs">
              <input
                type="checkbox"
                aria-label={`Restore #${task.number}`}
                className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-primary"
                checked={selected.has(task.number)}
                disabled={!task.projectOnBoard || restore.isPending}
                onChange={(event) => toggle(task.number, event.currentTarget.checked)}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  #{task.number} {task.title}
                </span>
                <span className="text-muted-foreground">
                  {task.change === "missing" ? "Missing" : "Changed"} · {task.projectName ?? "Unknown project"}
                  {task.projectOnBoard ? "" : " (not on the board)"}
                </span>
                {result ? (
                  <span className={result.ok ? "text-success-foreground" : "text-destructive-foreground"}>
                    {result.ok ? `Restored as #${result.boardNumber}` : result.error}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <div>
        <Button
          size="sm"
          disabled={selected.size === 0 || restore.isPending}
          onClick={() => restore.mutate([...selected])}
        >
          {restore.isPending ? <Spinner /> : null}
          Restore selected ({selected.size})
        </Button>
      </div>
      {restore.error ? <p className="text-destructive-foreground">{restore.error.message}</p> : null}
    </div>
  );
}

function BoardTab({ diff, source, onDone }: { diff: BackupDiff | undefined; source: Source; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [otherMachine, setOtherMachine] = useState<RestoreBoardInput["otherMachine"]>(undefined);
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () =>
      api<RestoreBoardResult>("/api/backup/restore-board", {
        method: "POST",
        body: { ...source, confirm: RESTORE_CONFIRM_WORD, ...(otherMachine ? { otherMachine } : {}) },
      }),
    // A take-over renames this machine to the old one's folder, which no live event reports.
    onSuccess: (result) => {
      if (result.tookOver) void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });
  if (restore.data) {
    return (
      <div className="flex flex-col gap-2">
        <p>The board was restored.</p>
        {restore.data.safetyCopy ? (
          <p className="text-muted-foreground">
            The board as it was is kept at <span className="break-all font-mono">{restore.data.safetyCopy}</span>.
          </p>
        ) : null}
        {restore.data.tookOver ? (
          <p className="text-muted-foreground">This machine now backs up to {restore.data.tookOver}/.</p>
        ) : null}
        <div>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }
  const needsChoice = diff?.otherMachine === true;
  return (
    <div className="flex flex-col gap-3">
      <p>
        Replaces every project, task, plan, label, template, automation and setting on this board with the backup's
        {diff ? ` (${diff.counts.backup} tasks; the board has ${diff.counts.board})` : ""}. This machine's own setup
        (the backup folder, the T3 token, Autopilot's pause) stays.
      </p>
      <p className="text-muted-foreground">
        The board as it is now is first copied beside the database as{" "}
        <span className="font-mono">.before-restore-…</span>, so the restore can be undone by hand.
      </p>
      {needsChoice ? (
        <div className="flex flex-col gap-2">
          <p>{diff.folder}/ is another machine's backup. Is this the same board on new hardware?</p>
          <ToggleGroup
            aria-label="Another machine's backup"
            value={otherMachine ? [otherMachine] : []}
            onValueChange={(next) => {
              if (next[0] === "take-over" || next[0] === "new-board") setOtherMachine(next[0]);
            }}
          >
            <Toggle value="take-over">Yes: take over {diff.folder}/</Toggle>
            <Toggle value="new-board">No: a new board, backed up to this machine's folder</Toggle>
          </ToggleGroup>
        </div>
      ) : null}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Type {RESTORE_CONFIRM_WORD} to confirm
        <Input
          size="sm"
          className="sm:w-48"
          aria-label={`Type ${RESTORE_CONFIRM_WORD} to confirm`}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
      </label>
      <div>
        <Button
          size="sm"
          variant="destructive"
          disabled={!diff || typed !== RESTORE_CONFIRM_WORD || (needsChoice && !otherMachine) || restore.isPending}
          onClick={() => restore.mutate()}
        >
          {restore.isPending ? <Spinner /> : null}
          Replace the board
        </Button>
      </div>
      {restore.error ? <p className="text-destructive-foreground">{restore.error.message}</p> : null}
    </div>
  );
}
