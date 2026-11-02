import { NOTIFICATION_GROUP_LABELS, type InboxNotification, type NotificationGroup } from "@repo/contracts";
import { BellIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useOpenTask } from "~/components/board/boardNavigation";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useMarkAllNotificationsRead, useMarkNotificationRead } from "~/state/mutations";
import { useNotifications } from "~/state/queries";
import { bellText, filterByGroup, groupsPresent, unreadDescription } from "./notifications.logic";

/** The header's bell: the unread count, and the attention inbox it opens. */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const unread = useNotifications().data?.unread ?? 0;
  const label = unread > 0 ? `Notifications, ${unreadDescription(unread)}` : "Notifications";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button variant={open ? "secondary" : "ghost-muted"} size="icon-sm" aria-label={label} />}
            />
          }
        >
          <BellIcon />
          <BellBadge count={unread} />
        </TooltipTrigger>
        <TooltipPopup>Notifications</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg" padding="none" aria-label="Notifications">
        <Inbox onClose={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  );
}

/** The red count on the bell: nine at most, then "9+". Nothing at zero. */
export function BellBadge({ count }: { count: number }) {
  const text = bellText(count);
  if (!text) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.625rem] leading-none font-semibold text-white tabular-nums"
    >
      {text}
    </span>
  );
}

function Inbox({ onClose }: { onClose: () => void }) {
  const inbox = useNotifications();
  const [group, setGroup] = useState<NotificationGroup | null>(null);
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const openTask = useOpenTask();
  const openSettings = useOpenSettings();
  const items = inbox.data?.items;
  const unread = inbox.data?.unread ?? 0;
  const present = useMemo(() => groupsPresent(items ?? []), [items]);
  // A filter for a group that has since aged out would show an empty list with no way back.
  const activeGroup = group && present.includes(group) ? group : null;
  const shown = useMemo(() => filterByGroup(items ?? [], activeGroup), [items, activeGroup]);

  const open = (n: InboxNotification) => {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.taskId) void openTask(n.taskId);
    else if (n.kind === "suggestion") openSettings("tasks.suggestions");
    // The section lists the drafts waiting, each with a link to its import page.
    else if (n.kind === "automation_draft") openSettings("autopilot.custom");
    else if (n.kind === "backup_notice") openSettings("board.data");
    onClose();
  };

  return (
    <div className="flex max-h-[min(32rem,var(--available-height))] flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
        <h2 className="text-sm font-medium">Notifications</h2>
        <Button
          variant="ghost-muted"
          size="sm"
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all read
        </Button>
      </div>
      {present.length > 1 ? (
        <div
          // shrink-0: overflow-x makes overflow-y auto too, so without it the list squeezes this row into a scrollbar.
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/60 px-3 py-2"
          role="group"
          aria-label="Filter by type"
        >
          <FilterChip active={activeGroup === null} onClick={() => setGroup(null)}>
            All
          </FilterChip>
          {present.map((g) => (
            <FilterChip key={g} active={activeGroup === g} onClick={() => setGroup(g)}>
              {NOTIFICATION_GROUP_LABELS[g]}
            </FilterChip>
          ))}
        </div>
      ) : null}
      {inbox.isError ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">Couldn't load notifications.</p>
      ) : shown.length === 0 ? (
        <p className="px-3 py-8 text-center text-sm text-muted-foreground">
          {inbox.isPending ? "Loading..." : "Nothing needs you right now."}
        </p>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col py-1">
            {shown.map((n) => (
              <li key={n.id}>
                <NotificationRow notification={n} onOpen={open} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <Button variant={active ? "secondary" : "ghost-muted"} size="micro" aria-pressed={active} onClick={onClick}>
      {children}
    </Button>
  );
}

/** One line of the inbox. */
export function NotificationRow({
  notification: n,
  onOpen,
}: {
  notification: InboxNotification;
  onOpen: (n: InboxNotification) => void;
}) {
  const unread = n.readAt === null;
  return (
    <button
      type="button"
      aria-label={`${unread ? "Unread: " : ""}${n.title}. ${n.body.replaceAll("\n", ". ")}`}
      className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
      onClick={() => onOpen(n)}
    >
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", unread ? "bg-destructive" : "bg-transparent")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-sm", unread ? "font-medium" : "text-muted-foreground")}>
            {n.title}
          </span>
          <time dateTime={n.createdAt} className="shrink-0 text-xs text-muted-foreground/70">
            {formatRelativeTimeLabel(n.createdAt)}
          </time>
        </span>
        <span className="mt-0.5 line-clamp-2 text-xs whitespace-pre-line text-muted-foreground">{n.body}</span>
      </span>
    </button>
  );
}
