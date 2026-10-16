import { pickMergeMethod, prMergeAction, type MergeMethod, type TaskLink, type TaskSummary } from "@repo/contracts";
import { GitBranchIcon, GitMergeIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { useMergePr } from "~/state/mutations";
import { useBoard } from "~/state/queries";
import { useDialogs, useMergeMethods } from "~/state/ui";
import { MERGE_METHOD_LABEL, mergeDialogCopy, mergeRepoKey } from "./merge.logic";

type PolledPr = Extract<TaskLink, { kind: "pr" }> & { ref: NonNullable<Extract<TaskLink, { kind: "pr" }>["ref"]> };

/** Confirms a merge (or turning on auto-merge), driven by useDialogs().openMergePr. Mounted once. */
export function MergePrDialog() {
  const target = useDialogs((s) => s.mergePr);
  const close = useDialogs((s) => s.closeMergePr);
  const task = useBoard().data?.tasks.find((t) => t.id === target?.taskId);
  const link = task?.links.find((l): l is PolledPr => l.id === target?.linkId && l.kind === "pr" && l.ref !== null);
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogPopup showCloseButton={false} className="max-w-md">
        {task && link ? <MergeContent key={link.id} task={task} link={link} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function MergeContent({ task, link, onDone }: { task: TaskSummary; link: PolledPr; onDone: () => void }) {
  const snapshot = link.snapshot;
  // Read live: a poll can change what's offered while the dialog is open, and the merge itself
  // moves the task to Done. Keep the action the dialog opened with for its wording.
  const live = prMergeAction(task.status, snapshot);
  const [action] = useState<"merge" | "auto">(live === "auto" ? "auto" : "merge");
  const repoKey = mergeRepoKey(link.ref);
  const lastPicked = useMergeMethods((s) => s.lastByRepo[repoKey]);
  const remember = useMergeMethods((s) => s.remember);
  const allowed = snapshot?.mergeMethods ?? [];
  const [method, setMethod] = useState<MergeMethod | null>(() => pickMergeMethod(allowed, lastPicked));
  const merge = useMergePr({ silent: true });
  const copy = mergeDialogCopy(action);
  const unavailable = !merge.isPending && !merge.isSuccess && (live === null || live === "armed");

  const confirm = () => {
    if (!method) return;
    remember(repoKey, method);
    merge.mutate({ linkId: link.id, action, method }, { onSuccess: onDone });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>
          {link.ref.repo}#{link.ref.number} {snapshot?.title ?? ""}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3 text-sm">
        {snapshot?.headRef ? (
          <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate font-mono text-xs">{snapshot.headRef}</span>
          </p>
        ) : null}
        {allowed.length > 1 ? (
          <Select
            items={allowed.map((m) => ({ value: m, label: MERGE_METHOD_LABEL[m] }))}
            value={method}
            onValueChange={(value) => {
              if (value === "squash" || value === "merge" || value === "rebase") setMethod(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Merge method">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {allowed.map((m) => (
                <SelectItem key={m} value={m}>
                  {MERGE_METHOD_LABEL[m]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : method ? (
          <p className="text-muted-foreground">{MERGE_METHOD_LABEL[method]}</p>
        ) : null}
        <p className="text-muted-foreground">{copy.explain}</p>
        {unavailable ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertDescription>This pull request can't be merged from here any more.</AlertDescription>
          </Alert>
        ) : merge.error ? (
          <Alert variant="error">
            <TriangleAlertIcon />
            <AlertDescription>{merge.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button disabled={!method || unavailable || merge.isPending} onClick={confirm}>
          {merge.isPending ? <Spinner className="size-4" /> : <GitMergeIcon className="size-4" />}
          {merge.isPending ? copy.pending : copy.confirm}
        </Button>
      </DialogFooter>
    </>
  );
}
