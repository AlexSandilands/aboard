import type { BackupMachine, ImportTasksInput, ImportTasksResult, MachineTasks, TransferMode } from "@repo/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useOpenTask } from "~/components/board/boardNavigation";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { api } from "~/lib/api";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useBoard } from "~/state/queries";
import { blockedReason, matchNote, projectMap, projectTargets, taskNote } from "./moveTasks.logic";

/** Brings tasks from another machine's latest backup onto this board: moved (the default) or copied. */
export function MoveTasksDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [machine, setMachine] = useState("");
  const machines = useQuery({
    queryKey: ["backupMachines"],
    queryFn: ({ signal }) => api<BackupMachine[]>("/api/backup/machines", { signal }),
    enabled: open,
  });
  const others = (machines.data ?? []).filter((m) => !m.current);
  const folder = machine || others[0]?.folder || "";
  const offer = useQuery({
    queryKey: ["backupMachineTasks", folder],
    queryFn: ({ signal }) => api<MachineTasks>(`/api/backup/machines/${encodeURIComponent(folder)}/tasks`, { signal }),
    enabled: open && folder !== "",
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move tasks from another machine</DialogTitle>
          <DialogDescription>
            Picks tasks from another machine's latest backup. A moved task is archived on that machine at its next
            backup; a copy leaves it there.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-sm">
          {machines.isPending ? <Spinner /> : null}
          {machines.data && others.length === 0 ? (
            <p className="text-muted-foreground">
              No other machine backs up to this repo yet. Point another machine's backup at the same remote first.
            </p>
          ) : null}
          {others.length > 0 ? (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              Machine
              <Select
                items={others.map((m) => ({ value: m.folder, label: machineLabel(m) }))}
                value={folder}
                onValueChange={(next) => next && setMachine(next)}
              >
                <SelectTrigger size="sm" aria-label="Machine">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {others.map((m) => (
                    <SelectItem key={m.folder} value={m.folder}>
                      {machineLabel(m)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          {machines.error || offer.error ? (
            <p className="text-destructive-foreground">{(machines.error ?? offer.error)!.message}</p>
          ) : null}
          {offer.isFetching && !offer.data ? <Spinner /> : null}
          {offer.data ? <Picker key={`${folder}:${offer.data.commit}`} offer={offer.data} onDone={onClose} /> : null}
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

/** "desktop · backed up 3 hours ago": what's offered is only as new as that machine's last pushed backup. */
const machineLabel = (m: BackupMachine) =>
  `${m.folder} · ${m.lastCommitAt ? `backed up ${formatRelativeTimeLabel(m.lastCommitAt)}` : "no backup yet"}`;

function Picker({ offer, onDone }: { offer: MachineTasks; onDone: () => void }) {
  const [mode, setMode] = useState<TransferMode>("move");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, string>>({});
  const board = useBoard();
  const projectsHere = (board.data?.projects ?? []).filter((p) => p.archivedAt === null);
  const run = useMutation({
    mutationFn: (input: ImportTasksInput) =>
      api<ImportTasksResult>("/api/backup/import-tasks", { method: "POST", body: input }),
  });
  if (run.data) return <Results result={run.data} machine={offer.folder} onDone={onDone} />;

  const titles = new Map(offer.projects.map((p) => [p.id, p.title]));
  // Blocked tasks drop out of the selection when switching to Move.
  const selectable = new Set(offer.tasks.filter((t) => !blockedReason(t, mode)).map((t) => t.taskId));
  const chosen = new Set([...picked].filter((id) => selectable.has(id)));
  const targets = projectTargets(offer.projects, offer.tasks, chosen, choices);
  const unresolved = targets.some((t) => t.target === null);
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        {offer.lastCommitAt ? `${offer.folder}'s backup is from ${formatRelativeTimeLabel(offer.lastCommitAt)}. ` : ""}
        Anything changed there since isn't in it.
      </p>
      <ToggleGroup
        aria-label="Move or copy"
        value={[mode]}
        onValueChange={(next) => {
          if (next[0] === "move" || next[0] === "copy") setMode(next[0]);
        }}
      >
        <Toggle value="move">Move</Toggle>
        <Toggle value="copy">Copy</Toggle>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">
        {mode === "move"
          ? `${offer.folder} archives its copy at its next backup, and says where it went.`
          : `${offer.folder} keeps its copy; both boards carry on with it separately.`}{" "}
        T3 thread and agent session links stay behind; pull request and ticket links come along.
      </p>
      {offer.tasks.length === 0 ? (
        <p className="text-muted-foreground">{offer.folder}'s backup has no tasks.</p>
      ) : (
        <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {offer.tasks.map((task) => {
            const blocked = blockedReason(task, mode);
            return (
              <li key={task.taskId} className="flex items-start gap-2.5 px-3 py-2 text-xs">
                <input
                  type="checkbox"
                  aria-label={`Pick #${task.number}`}
                  className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-primary"
                  checked={chosen.has(task.taskId)}
                  disabled={blocked !== null || run.isPending}
                  onChange={(event) => toggle(task.taskId, event.currentTarget.checked)}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    #{task.number} {task.title}
                  </span>
                  <span className="text-muted-foreground">
                    {blocked ?? taskNote(task, titles.get(task.projectId) ?? null)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {targets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Into projects here</p>
          {targets.map(({ project, target }) => (
            <div key={project.id} className="flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:gap-3">
              <span className="flex min-w-0 flex-col sm:w-48">
                <span className="truncate">{project.title}</span>
                <span className="text-muted-foreground">{matchNote(project)}</span>
              </span>
              <Select
                items={projectsHere.map((p) => ({ value: p.id, label: p.title }))}
                value={target ?? ""}
                onValueChange={(next) => next && setChoices((prev) => ({ ...prev, [project.id]: next }))}
              >
                <SelectTrigger size="sm" aria-label={`Project here for ${project.title}`} className="sm:w-56">
                  <SelectValue placeholder="Pick a project" />
                </SelectTrigger>
                <SelectPopup>
                  {projectsHere.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ))}
        </div>
      ) : null}
      <div>
        <Button
          size="sm"
          disabled={chosen.size === 0 || unresolved || run.isPending}
          onClick={() =>
            run.mutate({ machine: offer.folder, taskIds: [...chosen], mode, projectMap: projectMap(targets) })
          }
        >
          {run.isPending ? <Spinner /> : null}
          {mode === "move" ? "Move" : "Copy"} {chosen.size} {chosen.size === 1 ? "task" : "tasks"}
        </Button>
      </div>
      {run.error ? <p className="text-destructive-foreground">{run.error.message}</p> : null}
    </div>
  );
}

function Results({ result, machine, onDone }: { result: ImportTasksResult; machine: string; onDone: () => void }) {
  const openTask = useOpenTask();
  const done = result.results.filter((r) => r.ok).length;
  return (
    <div className="flex flex-col gap-3">
      <p>
        {done} of {result.results.length} {result.mode === "move" ? "moved" : "copied"}.
        {result.mode === "move" && done > 0
          ? ` ${machine} archives its copies at its next backup, once this machine's backup has pushed.`
          : ""}
      </p>
      <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
        {result.results.map((r) => (
          <li key={r.taskId} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
            <span className="truncate">
              #{r.number} {r.title}
            </span>
            {r.ok ? (
              <span className="flex flex-wrap items-center gap-x-2 text-success-foreground">
                Now
                <button
                  type="button"
                  className="cursor-pointer underline underline-offset-2"
                  onClick={() => {
                    onDone();
                    void openTask(r.taskId);
                  }}
                >
                  #{r.boardNumber}
                </button>
                {r.warning ? <span className="text-warning-foreground">{r.warning}</span> : null}
              </span>
            ) : (
              <span className="text-destructive-foreground">{r.error}</span>
            )}
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
