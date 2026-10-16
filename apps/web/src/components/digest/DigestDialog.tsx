import { ChevronLeftIcon, ChevronRightIcon, NewspaperIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenTask } from "~/components/board/boardNavigation";
import { Markdown, type TaskLinks } from "~/components/markdown/Markdown";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
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
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { useDigests, useDigestWriting, useGenerateDigest, useMarkDigestRead } from "~/state/digests";
import { useBoard } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import {
  digestFacts,
  digestModeLabel,
  digestOptionLabel,
  formatDigestPeriod,
  neighbourDigest,
  pickDigest,
  taskIdsByNumber,
} from "./digest.logic";

/** The Autopilot digest: the newest one by default, older ones a step away. Driven by useDialogs().digestOpen. */
export function DigestDialog() {
  const open = useDialogs((s) => s.digestOpen);
  const setOpen = useDialogs((s) => s.setDigestOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-2xl">{open ? <DigestContent onClose={close} /> : null}</DialogPopup>
    </Dialog>
  );
}

function DigestContent({ onClose }: { onClose: () => void }) {
  const digests = useDigests();
  const writing = useDigestWriting();
  const generate = useGenerateDigest();
  const { mutate: markRead } = useMarkDigestRead();
  const tasks = useBoard().data?.tasks;
  const openTask = useOpenTask();
  // Null follows the newest, so a digest that arrives while the panel is open is the one shown.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const items = useMemo(() => digests.data?.items ?? [], [digests.data]);
  const shown = pickDigest(items, selectedId);
  const asked = useRef(new Set<string>());

  // Only the digest on screen is marked read, so browsing to an older one reads that one.
  useEffect(() => {
    if (!shown || shown.readAt || asked.current.has(shown.id)) return;
    asked.current.add(shown.id);
    markRead(shown.id);
  }, [shown, markRead]);

  const taskLinks = useMemo<TaskLinks>(() => {
    const ids = taskIdsByNumber(tasks ?? []);
    return {
      isKnown: (number) => ids.has(number),
      onOpen: (number) => {
        const id = ids.get(number);
        if (!id) return;
        onClose();
        void openTask(id);
      },
    };
  }, [tasks, openTask, onClose]);

  const busy = writing || generate.isPending;
  const older = neighbourDigest(items, shown?.id, "older");
  const newer = neighbourDigest(items, shown?.id, "newer");
  const select = (id: string) => setSelectedId(id === items[0]?.id ? null : id);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Digest of what changed</DialogTitle>
        <DialogDescription>{shown ? formatDigestPeriod(shown) : "What changed on the board."}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3">
        {writing ? (
          <Alert variant="info">
            <Spinner aria-hidden />
            <AlertDescription>
              An agent is writing a digest. It can take a few minutes, and it appears here when it is done.
            </AlertDescription>
          </Alert>
        ) : null}
        {shown ? (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Badge variant={shown.mode === "summarised" ? "info" : "outline"}>{digestModeLabel(shown.mode)}</Badge>
              <span>{digestFacts(shown).join(" · ")}</span>
            </div>
            {shown.note ? <p className="text-xs text-muted-foreground">{shown.note}</p> : null}
            <Markdown taskLinks={taskLinks} images={false}>
              {shown.bodyMd}
            </Markdown>
          </>
        ) : digests.isError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Couldn't load the digests.</p>
        ) : digests.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading...</p>
        ) : (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <NewspaperIcon />
              </EmptyMedia>
              <EmptyTitle>No digest yet</EmptyTitle>
              <EmptyDescription>
                A digest lists what changed on the board since the last one. Generate one now, or switch the automation
                on in Autopilot settings to get one on a schedule.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </DialogPanel>
      <DialogFooter>
        {items.length > 1 && shown ? (
          <div className="flex items-center gap-1 sm:me-auto">
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Older digest"
              disabled={!older}
              onClick={() => older && select(older)}
            >
              <ChevronLeftIcon />
            </Button>
            <Select
              items={items.map((d) => ({ value: d.id, label: digestOptionLabel(d) }))}
              value={shown.id}
              onValueChange={(id) => id && select(id)}
            >
              <SelectTrigger size="sm" className="sm:w-52" aria-label="Digest">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {items.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {digestOptionLabel(d)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Newer digest"
              disabled={!newer}
              onClick={() => newer && select(newer)}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
        <Button
          disabled={busy}
          onClick={() => generate.mutate(undefined, { onSuccess: ({ digest }) => digest && setSelectedId(null) })}
        >
          {busy ? <Spinner aria-hidden /> : null}
          {busy ? "Writing..." : "Generate now"}
        </Button>
      </DialogFooter>
    </>
  );
}
