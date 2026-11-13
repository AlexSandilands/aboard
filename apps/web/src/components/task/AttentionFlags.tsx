import type { AttentionReason, TaskDetail } from "@repo/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { AttentionIcon } from "~/components/board/attention";
import { Button } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useDismissAttention, useRestoreAttention } from "~/state/mutations";
import { flagSection, stripFlags } from "./attentionFlags.logic";

const BOX = "flex min-w-0 flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-card/40 text-sm";
const ROW = "flex min-w-0 items-center gap-2 px-3 py-1.5";

/**
 * Why the task needs attention, a row per flag with its own Dismiss, and under it the flags the user dismissed, to
 * restore. Here rather than in each section so a flag can be seen and dismissed whether its section is open, collapsed
 * or hidden. A dismissed flag comes back by itself when what raised it changes. Renders nothing with neither.
 */
export function AttentionFlags({ task }: { task: TaskDetail }) {
  const { mutate: dismiss, isPending: dismissing } = useDismissAttention();
  const { mutate: restore, isPending: restoring } = useRestoreAttention();
  const [open, setOpen] = useState(false);
  const flags = stripFlags(task.attention);
  const dismissed = task.dismissedAttention;
  if (flags.length === 0 && dismissed.length === 0) return null;
  return (
    <>
      {flags.length > 0 ? (
        <div className={BOX}>
          {flags.map((flag) => (
            <div key={flag.key} className={ROW}>
              <FlagText flag={flag} />
              <Button
                size="xs"
                variant="outline"
                disabled={dismissing}
                title="Hide this flag. It comes back if what raised it changes."
                onClick={() => dismiss({ taskId: task.id, key: flag.key })}
              >
                Dismiss
              </Button>
            </div>
          ))}
          {/* Counts every flag on the task, the callouts' too: Dismiss all clears those as well. */}
          {task.attention.length > 1 ? (
            <div className={ROW}>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">{task.attention.length} flags</span>
              <Button size="xs" variant="ghost" disabled={dismissing} onClick={() => dismiss({ taskId: task.id })}>
                Dismiss all
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {dismissed.length > 0 ? (
        <div className={BOX}>
          <div className={cn(ROW, "py-1")}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRightIcon
                aria-hidden
                className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
              />
              {dismissed.length} dismissed
            </button>
            {open && dismissed.length > 1 ? (
              <Button size="xs" variant="ghost" disabled={restoring} onClick={() => restore({ taskId: task.id })}>
                Restore all
              </Button>
            ) : null}
          </div>
          {open
            ? dismissed.map((flag) => (
                <div key={flag.key} className={ROW}>
                  <FlagText
                    flag={flag}
                    dimmed
                    note={`${flag.dismissedBy} · ${formatRelativeTimeLabel(flag.dismissedAt)}`}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={restoring}
                    onClick={() => restore({ taskId: task.id, key: flag.key })}
                  >
                    Restore
                  </Button>
                </div>
              ))
            : null}
        </div>
      ) : null}
    </>
  );
}

/** A flag's icon and message, then where it comes from (or `note`); the message wraps, the rest doesn't. */
function FlagText({ flag, dimmed, note }: { flag: AttentionReason; dimmed?: boolean; note?: string }) {
  const aside = note ?? flagSection(flag.kind);
  return (
    <>
      <AttentionIcon severity={flag.severity} className={cn("size-4", dimmed && "opacity-60")} />
      <span
        className={cn(
          "min-w-0 flex-1 [overflow-wrap:anywhere]",
          dimmed ? "text-muted-foreground" : "text-foreground/90",
        )}
      >
        {flag.message}
      </span>
      {aside ? <span className="shrink-0 text-xs text-muted-foreground">{aside}</span> : null}
    </>
  );
}
