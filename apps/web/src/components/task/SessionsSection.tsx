import {
  AGENT_HARNESSES,
  type AppSettings,
  type T3IntegrationStatus,
  type TaskDetail,
  type TaskLink,
} from "@repo/contracts";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { HarnessIcon, SessionMenuItems, T3Icon } from "~/components/sessions/SessionParts";
import {
  folderName,
  isSettledSession,
  sessionName,
  sessionStatusPresentation,
  sessionTitle,
  type SessionLink,
} from "~/components/sessions/sessions.logic";
import { useSessionActions } from "~/components/sessions/useSessionActions";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { openHref, t3LinkTargets } from "~/lib/t3Links";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useBoard, useSettings } from "~/state/queries";
import { copyToClipboard } from "./InlineInput";
import { linkProps, RemoveItem, T3_UNDETECTED, useRemoveTaskLink } from "./LinksSection";
import {
  groupLinks,
  isActiveThread,
  previewRows,
  SESSION_PREVIEW_COUNT,
  threadDetails,
  threadModelsDiffer,
  threadStatusPresentation,
} from "./links.logic";
import {
  PANEL_ICON_CLASS,
  PANEL_LABEL_CLASS,
  PanelControl,
  PanelSplitGroup,
  PanelSplitSeparator,
} from "./PanelControl";
import { TaskSection } from "./TaskSection";

/** The task's T3 threads and agent sessions, in a section of their own so Links stays PRs, issues, Jira keys and URLs. */
export function SessionsSection({ task }: { task: TaskDetail }) {
  const board = useBoard().data;
  const settings = useSettings().data;
  const remove = useRemoveTaskLink(task.id);
  const t3 = board?.integrations.t3 ?? T3_UNDETECTED;
  const [showAll, setShowAll] = useState(false);
  const { sessionRows, folded } = groupLinks(task.links);
  const threads = sessionRows.filter((row) => row.kind === "t3_thread");
  // One thread keeps the compact row; several get details so they can be told apart.
  const multiThread =
    threads.length > 1 ? { firstId: threads[0]!.id, showModel: threadModelsDiffer(threads) } : undefined;
  const { shown, hidden } = previewRows(sessionRows, showAll);

  return (
    <TaskSection title="Sessions">
      <div className="flex flex-col gap-0.5">
        {sessionRows.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-muted-foreground">No coding sessions yet</p>
        ) : null}
        {shown.map((row) =>
          row.kind === "t3_thread" ? (
            <T3ThreadRow
              key={row.id}
              taskId={task.id}
              link={row}
              t3={t3}
              settings={settings}
              multiThread={multiThread}
              sessions={folded}
              onRemove={() => remove(row.id)}
              onRemoveSession={remove}
            />
          ) : (
            <SessionRow key={row.id} taskId={task.id} link={row} onRemove={() => remove(row.id)} />
          ),
        )}
        {sessionRows.length > SESSION_PREVIEW_COUNT ? (
          <PanelControl
            part="meta"
            tone="muted"
            className="ms-2 self-start"
            aria-expanded={showAll}
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "Show fewer" : `Show ${hidden} more`}
          </PanelControl>
        ) : null}
      </div>
    </TaskSection>
  );
}

interface MultiThread {
  firstId: string;
  showModel: boolean;
}

function T3ThreadRow({
  taskId,
  link,
  t3,
  settings,
  multiThread,
  sessions,
  onRemove,
  onRemoveSession,
}: {
  taskId: string;
  link: Extract<TaskLink, { kind: "t3_thread" }>;
  t3: T3IntegrationStatus;
  settings: AppSettings | undefined;
  multiThread: MultiThread | undefined;
  /** The Claude Code sessions folded into this thread's menu. */
  sessions: ReadonlyArray<SessionLink>;
  onRemove: () => void;
  onRemoveSession: (linkId: string) => void;
}) {
  const { open } = useSessionActions(taskId);
  const targets = t3LinkTargets(link.ref, t3, settings);
  const snapshot = link.snapshot;
  const status = snapshot ? threadStatusPresentation(snapshot.status) : null;
  const title = snapshot?.title ?? link.label;
  const showOpenLabel = !multiThread || multiThread.firstId === link.id;
  const details = multiThread
    ? [
        ...threadDetails(snapshot, { showModel: multiThread.showModel }),
        snapshot?.lastActivityAt ? formatRelativeTimeLabel(snapshot.lastActivityAt) : null,
      ].filter(Boolean)
    : [];
  const dimmed = !isActiveThread(snapshot);
  const statusBadge = status ? (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-normal", status.colorClass)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
      {status.label}
    </span>
  ) : null;
  return (
    <PanelSplitGroup className={cn(dimmed && "opacity-60 hover:opacity-100 has-[[data-popup-open]]:opacity-100")}>
      <PanelControl
        part="primary"
        title={targets.primary.label}
        className={cn(multiThread && "h-auto items-start py-1.5")}
        render={<a {...linkProps(targets.primary.href)} />}
      >
        <T3Icon className={PANEL_ICON_CLASS} />
        {multiThread ? (
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex min-w-0 items-center gap-2.5">
              {showOpenLabel ? <span className={cn(PANEL_LABEL_CLASS, "shrink-0")}>Open in T3 Code</span> : null}
              <span className={cn(PANEL_LABEL_CLASS, "flex-1", showOpenLabel && "font-normal text-muted-foreground")}>
                {title}
              </span>
              {statusBadge}
            </span>
            {details.length > 0 ? (
              <span className="min-w-0 truncate text-xs leading-4 font-normal text-muted-foreground">
                {details.join(" · ")}
              </span>
            ) : null}
          </span>
        ) : (
          <>
            <span className={cn(PANEL_LABEL_CLASS, "shrink-0")}>Open in T3 Code</span>
            <span className={cn(PANEL_LABEL_CLASS, "flex-1 font-normal text-muted-foreground")}>{title}</span>
            {statusBadge}
          </>
        )}
      </PanelControl>
      <PanelSplitSeparator />
      <Menu>
        <MenuTrigger
          render={
            <PanelControl
              part="secondary"
              aria-label="More thread actions"
              className={cn(multiThread && "h-auto self-stretch")}
            />
          }
        >
          <ChevronDownIcon className={PANEL_ICON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end">
          {targets.secondary ? (
            <MenuItem onClick={() => openHref(targets.secondary!.href)}>
              <ExternalLinkIcon />
              {targets.secondary.label}
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => copyToClipboard(link.ref.threadId, "thread id")}>
            <CopyIcon />
            Copy thread id
          </MenuItem>
          {sessions.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>Claude Code sessions</MenuGroupLabel>
                {sessions.map((session) => (
                  <FoldedSession
                    key={session.id}
                    link={session}
                    onOpen={(mode) => open(session, mode)}
                    onRemove={() => onRemoveSession(session.id)}
                  />
                ))}
              </MenuGroup>
            </>
          ) : null}
          <RemoveItem onRemove={onRemove} />
        </MenuPopup>
      </Menu>
    </PanelSplitGroup>
  );
}

/** A session that belongs to the thread above it: a submenu of what a session row offers. */
function FoldedSession({
  link,
  onOpen,
  onRemove,
}: {
  link: SessionLink;
  onOpen: (mode: "resume" | "fork") => void;
  onRemove: () => void;
}) {
  const status = sessionStatusPresentation(link.snapshot);
  return (
    <MenuSub>
      <MenuSubTrigger>
        <HarnessIcon harness={link.ref.harness} />
        <span className="min-w-0 max-w-56 truncate">{sessionTitle(link)}</span>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-xs", status.colorClass)}>
          <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
          {status.label}
        </span>
      </MenuSubTrigger>
      <MenuSubPopup>
        <SessionMenuItems link={link} onOpen={onOpen} />
        <MenuItem onClick={() => copyToClipboard(link.ref.sessionId, "session id")}>
          <CopyIcon />
          Copy session id
        </MenuItem>
        <RemoveItem onRemove={onRemove} />
      </MenuSubPopup>
    </MenuSub>
  );
}

/** An agent session: its name, folder and live status; a click opens it in a terminal, the rest is in its menu. */
function SessionRow({ taskId, link, onRemove }: { taskId: string; link: SessionLink; onRemove: () => void }) {
  const { open, pending } = useSessionActions(taskId);
  const status = sessionStatusPresentation(link.snapshot);
  const harness = AGENT_HARNESSES[link.ref.harness].label;
  const name = sessionName(link);
  return (
    <PanelSplitGroup className={cn(isSettledSession(link.snapshot) && "opacity-80 hover:opacity-100")}>
      <PanelControl
        part="primary"
        title={`Open in a terminal: ${harness} session ${link.ref.sessionId} in ${link.ref.cwd}`}
        disabled={pending}
        onClick={() => open(link)}
      >
        <HarnessIcon harness={link.ref.harness} className="size-4" />
        <span className={cn(PANEL_LABEL_CLASS, "min-w-0 flex-1")}>{name ?? `${harness} session`}</span>
        <span className={cn(PANEL_LABEL_CLASS, "max-w-[35%] shrink-0 font-normal text-muted-foreground")}>
          {folderName(link.ref.cwd)}
        </span>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-normal", status.colorClass)}>
          <span aria-hidden className={cn("size-1.5 rounded-full", status.dotClass)} />
          {link.snapshot?.inApp && !isSettledSession(link.snapshot) ? `${status.label} in T3` : status.label}
        </span>
      </PanelControl>
      <PanelSplitSeparator />
      <Menu>
        <MenuTrigger render={<PanelControl part="secondary" aria-label="More session actions" />}>
          <ChevronDownIcon className={PANEL_ICON_CLASS} />
        </MenuTrigger>
        <MenuPopup align="end">
          <SessionMenuItems link={link} includeOpen={false} onOpen={(mode) => open(link, mode)} />
          <MenuItem onClick={() => copyToClipboard(link.ref.sessionId, "session id")}>
            <CopyIcon />
            Copy session id
          </MenuItem>
          <MenuItem onClick={() => copyToClipboard(link.ref.cwd, "folder")}>
            <CopyIcon />
            Copy folder
          </MenuItem>
          <RemoveItem onRemove={onRemove} />
        </MenuPopup>
      </Menu>
    </PanelSplitGroup>
  );
}
