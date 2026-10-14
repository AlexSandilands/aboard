import type { TaskDetail, TaskResolution } from "@repo/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useResolveTask } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { closeCandidates, closeDialogTitle } from "./resolution.logic";

export type PickResolution = Exclude<TaskResolution, "wont_do">;

/** Picks the task that delivered (or duplicates) `task`, then closes it against that task. */
export function CloseTaskDialog({
  task,
  resolution,
  onOpenChange,
}: {
  task: TaskDetail;
  /** null keeps the dialog closed. */
  resolution: PickResolution | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  // Keep the last resolution while the dialog animates out, so its title and list don't blank.
  const [shown, setShown] = useState(resolution);
  if (resolution && resolution !== shown) setShown(resolution);
  // Start each opening with an empty search.
  const [wasOpen, setWasOpen] = useState(resolution !== null);
  if (wasOpen !== (resolution !== null)) {
    setWasOpen(resolution !== null);
    if (resolution) setQuery("");
  }
  const board = useBoard().data;
  const { mutate: resolveTask, isPending } = useResolveTask();
  const candidates = closeCandidates(board?.tasks ?? [], task, query);

  const pick = (byTask: string) => {
    if (!shown || isPending) return;
    resolveTask(
      { id: task.id, resolution: shown, byTask },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  };

  return (
    <Dialog open={resolution !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="w-full sm:w-[28rem]">
        <DialogHeader>
          <DialogTitle>{shown ? closeDialogTitle(task.number, shown) : null}</DialogTitle>
          <DialogDescription>
            It moves to Done without needing a plan, and the other task shows it also resolved #{task.number}.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-2">
          <Input
            autoFocus
            type="search"
            aria-label="Find a task"
            placeholder="Search by #number or title"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              const first = candidates[0];
              if (event.key !== "Enter" || !first) return;
              event.preventDefault();
              pick(first.id);
            }}
          />
          <ul className="flex max-h-72 flex-col overflow-y-auto" aria-label="Tasks">
            {candidates.map((candidate) => {
              const project =
                candidate.projectId === task.projectId
                  ? null
                  : board?.projects.find((p) => p.id === candidate.projectId);
              return (
                <li key={candidate.id}>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => pick(candidate.id)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-60"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                      #{candidate.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                    {project ? <span className="shrink-0 text-xs text-muted-foreground">{project.title}</span> : null}
                  </button>
                </li>
              );
            })}
            {candidates.length === 0 ? (
              <li className="px-2 py-3 text-center text-xs text-muted-foreground">No matching tasks</li>
            ) : null}
          </ul>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
