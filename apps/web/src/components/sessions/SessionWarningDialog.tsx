import { GitForkIcon, MessagesSquareIcon, SquareTerminalIcon } from "lucide-react";
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
import { t3LinkTargets } from "~/lib/t3Links";
import { useBoard, useSettings } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { sessionTitle, sessionWarning, type SessionLink } from "./sessions.logic";
import { useSessionActions } from "./useSessionActions";

/** Asks what to do about a session that is still running: fork it, open it anyway, or go to its T3 thread. */
export function SessionWarningDialog() {
  const target = useDialogs((s) => s.sessionWarning);
  const close = useDialogs((s) => s.closeSessionWarning);
  const board = useBoard().data;
  const task = board?.tasks.find((t) => t.id === target?.taskId);
  const link = task?.links.find((l): l is SessionLink => l.id === target?.linkId && l.kind === "agent_session");
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogPopup showCloseButton={false} className="max-w-md">
        {target && task && link ? <WarningContent taskId={task.id} link={link} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function WarningContent({ taskId, link, onDone }: { taskId: string; link: SessionLink; onDone: () => void }) {
  const target = useDialogs((s) => s.sessionWarning);
  const board = useBoard().data;
  const settings = useSettings().data;
  const { open, pending } = useSessionActions(taskId);
  const thread = board?.tasks.find((t) => t.id === taskId)?.links.find((l) => l.kind === "t3_thread");
  const warning = sessionWarning(link, target?.snapshot ?? link.snapshot, { hasThread: !!thread });
  const threadHref =
    warning.offerThread && thread?.kind === "t3_thread" && board
      ? t3LinkTargets(thread.ref, board.integrations.t3, settings).primary.href
      : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{warning.title}</DialogTitle>
        <DialogDescription>{sessionTitle(link)}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="text-sm text-muted-foreground">{warning.body}</DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        {threadHref ? (
          <Button variant="outline" render={<a href={threadHref} aria-label="Open T3 thread" onClick={onDone} />}>
            <MessagesSquareIcon className="size-4" />
            Open T3 thread
          </Button>
        ) : null}
        <Button
          variant={warning.canFork ? "outline" : "default"}
          disabled={pending}
          onClick={() => open(link, "resume", true, onDone)}
        >
          <SquareTerminalIcon className="size-4" />
          Open anyway
        </Button>
        {warning.canFork ? (
          <Button autoFocus disabled={pending} onClick={() => open(link, "fork", false, onDone)}>
            <GitForkIcon className="size-4" />
            Fork
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
