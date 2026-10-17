import { NewspaperIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useDigests, useDigestWriting } from "~/state/digests";
import { useDialogs } from "~/state/ui";
import { digestButtonText } from "./digest.logic";

/**
 * The header's digest button: opens the digest panel, with a dot while a digest is unread and a spinner while an
 * agent is writing one. It stays clickable then, so the older digests can still be read.
 */
export function DigestButton() {
  const open = useDialogs((s) => s.digestOpen);
  const setOpen = useDialogs((s) => s.setDigestOpen);
  const unread = useDigests().data?.unread ?? 0;
  const writing = useDigestWriting();
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={open ? "secondary" : "ghost-muted"} size="icon-sm" onClick={() => setOpen(true)} />}
      >
        {writing ? <Spinner aria-hidden /> : <NewspaperIcon />}
        {unread > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-destructive ring-2 ring-background"
          />
        ) : null}
        <span className="sr-only">{digestButtonText(unread, writing)}</span>
      </TooltipTrigger>
      <TooltipPopup>Digest of what changed</TooltipPopup>
    </Tooltip>
  );
}
