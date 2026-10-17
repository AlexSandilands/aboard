import {
  AGENT_HARNESSES,
  BRAND,
  classifyLink,
  prMergeAction,
  type AppSettings,
  type T3IntegrationStatus,
  type TaskDetail,
  type TaskLink,
} from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GlobeIcon,
  MessagesSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TicketIcon,
  Trash2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { copyTaskReference } from "~/components/handoff/HandoffActions";
import { HarnessIcon, SessionMenuItems } from "~/components/sessions/SessionParts";
import {
  folderName,
  sessionName,
  isSettledSession,
  sessionStatusPresentation,
  sessionTitle,
  type SessionLink,
} from "~/components/sessions/sessions.logic";
import { useSessionActions } from "~/components/sessions/useSessionActions";
import { mergeButtonLabel } from "~/components/merge/merge.logic";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
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
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { openHref, t3LinkTargets } from "~/lib/t3Links";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useAddLink, useMergePr, useRefreshLink, useRemoveLink } from "~/state/mutations";
import { queryKeys, useBoard, useSettings } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { copyToClipboard } from "./InlineInput";
import {
  describeLinkInput,
  hostnameOf,
  isActiveThread,
  ISSUE_STATE,
  isWebUrl,
  groupLinks,
  jiraHref,
  previewRows,
  SESSION_PREVIEW_COUNT,
  threadDetails,
  threadModelsDiffer,
  threadStatusPresentation,
  unrecognisedLinkHint,
  type PlainLink,
} from "./links.logic";
import {
  PANEL_ICON_CLASS,
  PANEL_LABEL_CLASS,
  PanelControl,
  PanelSplitGroup,
  PanelSplitSeparator,
  ROW_HOVER_ACTION_CLASS,
} from "./PanelControl";
import { TaskSection } from "./TaskSection";

const T3_UNDETECTED: T3IntegrationStatus = {
  detected: false,
  origin: null,
  environmentId: null,
  label: null,
  liveStatus: "off",
  error: null,
};

// PR state colours from T3 (pullRequest/pullRequestIcons.tsx).
const PR_STATE: Record<"open" | "draft" | "closed" | "merged", { label: string; tone: string }> = {
  open: { label: "Open", tone: "text-emerald-600 dark:text-emerald-300/90" },
  draft: { label: "Draft", tone: "text-zinc-500 dark:text-zinc-400/80" },
  closed: { label: "Closed", tone: "text-red-600 dark:text-red-300/90" },
  merged: { label: "Merged", tone: "text-violet-600 dark:text-violet-300/90" },
};

export const LINK_KIND_ICON: Record<TaskLink["kind"], LucideIcon> = {
  pr: GitPullRequestArrowIcon,
  jira: TicketIcon,
  t3_thread: MessagesSquareIcon,
  issue: CircleDotIcon,
  agent_session: SquareTerminalIcon,
  url: GlobeIcon,
};

/** Anchor props: web URLs open in a new tab, app deep links (t3code://) in place. */
const linkProps = (href: string) => (isWebUrl(href) ? { href, target: "_blank", rel: "noreferrer" } : { href });

export function LinksSection({ task }: { task: TaskDetail }) {
  const board = useBoard().data;
  const settings = useSettings().data;
  const queryClient = useQueryClient();
  const { mutate: removeLink } = useRemoveLink();
  const t3 = board?.integrations.t3 ?? T3_UNDETECTED;

  const remove = (linkId: string) => {
    queryClient.setQueryData<TaskDetail>(queryKeys.task(task.id), (detail) =>
      detail ? { ...detail, links: detail.links.filter((l) => l.id !== linkId) } : detail,
    );
    removeLink(linkId, { onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) }) });
  };

  const [showAllSessions, setShowAllSessions] = useState(false);
  const { sessionRows, folded, links } = groupLinks(task.links);
  const threads = sessionRows.filter((row) => row.kind === "t3_thread");
  // One thread keeps the compact row; several get details so they can be told apart.
  const multiThread =
    threads.length > 1 ? { firstId: threads[0]!.id, showModel: threadModelsDiffer(threads) } : undefined;
  const { shown, hidden } = previewRows(sessionRows, showAllSessions);

  return (
    <TaskSection
      title="Links"
      actions={
        <PanelControl
          part="meta"
          title="Copy the task's title, board link and get_task call, to start a new session on it"
          onClick={() => copyTaskReference(task)}
        >
          <CopyIcon className="size-3.5" />
          Copy {BRAND.id} link
        </PanelControl>
      }
    >
      <div className="flex flex-col gap-0.5">
        {/* The headings only appear once there is something to tell apart: a task with no sessions reads as before. */}
        {sessionRows.length > 0 ? (
          <>
            <GroupHeading>Sessions</GroupHeading>
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
            {hidden > 0 || (showAllSessions && sessionRows.length > SESSION_PREVIEW_COUNT) ? (
              <PanelControl
                part="meta"
                tone="muted"
                className="ms-2 self-start"
                aria-expanded={showAllSessions}
                onClick={() => setShowAllSessions(!showAllSessions)}
              >
                {showAllSessions ? "Show fewer" : `Show ${hidden} more`}
              </PanelControl>
            ) : null}
            <GroupHeading className="mt-1.5">Links</GroupHeading>
          </>
        ) : null}
        {links.map((link) => (
          <LinkRow key={link.id} task={task} link={link} settings={settings} onRemove={() => remove(link.id)} />
        ))}
        <AddLinkPopover taskId={task.id} jiraBaseUrl={settings?.jiraBaseUrl ?? null} t3={t3} />
      </div>
    </TaskSection>
  );
}

/** A small heading with a rule, to split the section into groups without another collapse. */
export function GroupHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 px-2.5 pt-0.5 pb-0.5", className)}>
      <span className="text-2xs font-medium text-muted-foreground">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  );
}

interface MultiThread {
  firstId: string;
  showModel: boolean;
}

function LinkRow({
  task,
  link,
  settings,
  onRemove,
}: {
  task: TaskDetail;
  link: PlainLink;
  settings: AppSettings | undefined;
  onRemove: () => void;
}) {
  switch (link.kind) {
    case "pr":
      return <PullRequestRow task={task} link={link} onRemove={onRemove} />;
    case "issue":
      return <IssueRow link={link} onRemove={onRemove} />;
    case "jira": {
      const href = jiraHref(link, settings?.jiraBaseUrl);
      return (
        <RowWithMenu
          href={href}
          title={href ?? link.ref.key}
          menu={
            <>
              <MenuItem onClick={() => copyToClipboard(link.ref.key, "Jira key")}>
                <CopyIcon />
                Copy key
              </MenuItem>
              <RemoveItem onRemove={onRemove} />
            </>
          }
        >
          <TicketIcon className={PANEL_ICON_CLASS} />
          <span className="shrink-0 font-mono text-xs">{link.ref.key}</span>
          {link.label ? (
            <span className={cn(PANEL_LABEL_CLASS, "flex-1 font-normal text-muted-foreground")}>{link.label}</span>
          ) : null}
        </RowWithMenu>
      );
    }
    case "url":
      return (
        <RowWithMenu
          href={link.url}
          title={link.url}
          menu={
            <>
              <MenuItem onClick={() => copyToClipboard(link.url, "URL")}>
                <CopyIcon />
                Copy URL
              </MenuItem>
              <RemoveItem onRemove={onRemove} />
            </>
          }
        >
          <GlobeIcon className={PANEL_ICON_CLASS} />
          <span className={cn(PANEL_LABEL_CLASS, "flex-1")}>{link.label ?? hostnameOf(link.url) ?? link.url}</span>
        </RowWithMenu>
      );
  }
}

/** A link row whose actions live in a menu revealed on hover. */
function RowWithMenu({
  href,
  title,
  menu,
  action,
  children,
}: {
  href: string | null;
  title: string;
  menu: ReactNode;
  /** An always-visible action between the row and its menu. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PanelSplitGroup>
      {/* oxlint-disable-next-line jsx-a11y/anchor-has-content -- Base UI's render prop receives PanelControl's children */}
      <PanelControl part="fill" title={title} render={href ? <a {...linkProps(href)} /> : <div />}>
        {children}
      </PanelControl>
      {action}
      <RowMenu>{menu}</RowMenu>
    </PanelSplitGroup>
  );
}

function RowMenu({ children }: { children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger
        render={<PanelControl part="icon" aria-label="Link actions" className={cn("me-1", ROW_HOVER_ACTION_CLASS)} />}
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">{children}</MenuPopup>
    </Menu>
  );
}

function RemoveItem({ onRemove }: { onRemove: () => void }) {
  return (
    <>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={onRemove}>
        <Trash2Icon />
        Remove link
      </MenuItem>
    </>
  );
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
        <MessagesSquareIcon className={PANEL_ICON_CLASS} />
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
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)} />
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

function PullRequestRow({
  task,
  link,
  onRemove,
}: {
  task: TaskDetail;
  link: Extract<TaskLink, { kind: "pr" }>;
  onRemove: () => void;
}) {
  const { mutate: refresh, isPending: refreshing } = useRefreshLink();
  const { mutate: mergePr, isPending: disabling } = useMergePr();
  const openMergePr = useDialogs((s) => s.openMergePr);
  const snapshot = link.snapshot;
  const mergeAction = prMergeAction(task.status, snapshot);
  const state = snapshot ? PR_STATE[snapshot.state] : null;
  const title = snapshot?.title ?? link.label ?? (link.ref ? link.ref.repo : (hostnameOf(link.url) ?? link.url));
  return (
    <RowWithMenu
      href={link.url}
      title={state ? `${state.label} pull request · ${link.url}` : link.url}
      action={
        mergeAction === "merge" || mergeAction === "auto" ? (
          <PanelControl part="meta" tone="primary" onClick={() => openMergePr(task.id, link.id)}>
            <GitMergeIcon className="size-3.5" />
            {mergeButtonLabel(mergeAction)}
          </PanelControl>
        ) : null
      }
      menu={
        <>
          {link.ref ? (
            <MenuItem disabled={refreshing} onClick={() => refresh(link.id)}>
              <RefreshCwIcon />
              Refresh
            </MenuItem>
          ) : null}
          {mergeAction === "armed" ? (
            <MenuItem disabled={disabling} onClick={() => mergePr({ linkId: link.id, action: "disable_auto" })}>
              <GitMergeIcon />
              Disable auto-merge
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => copyToClipboard(link.url, "URL")}>
            <CopyIcon />
            Copy URL
          </MenuItem>
          <RemoveItem onRemove={onRemove} />
        </>
      }
    >
      <GitPullRequestArrowIcon className={cn("size-4 shrink-0", state?.tone ?? "text-muted-foreground")} />
      {link.ref ? <span className="shrink-0 tabular-nums text-muted-foreground">#{link.ref.number}</span> : null}
      <span className={cn(PANEL_LABEL_CLASS, "flex-1")}>{title}</span>
      {snapshot ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-normal">
          {snapshot.state === "open" && snapshot.autoMerge ? (
            <Badge variant="info" size="sm">
              Auto-merge on
            </Badge>
          ) : null}
          {snapshot.mergeable === "conflicting" ? (
            <Hint label="Merge conflicts">
              <TriangleAlertIcon className="size-3.5 text-warning" />
            </Hint>
          ) : null}
          {snapshot.checks === "passing" ? (
            <Hint label="Checks passing">
              <CircleCheckIcon className="size-3.5 text-success" />
            </Hint>
          ) : snapshot.checks === "failing" ? (
            <Hint label="Checks failing">
              <CircleXIcon className="size-3.5 text-destructive-foreground" />
            </Hint>
          ) : snapshot.checks === "pending" ? (
            <Hint label="Checks running">
              <CircleDashedIcon className="size-3.5 text-warning" />
            </Hint>
          ) : null}
          {snapshot.reviewDecision === "approved" ? (
            <span className="text-success-foreground">Approved</span>
          ) : snapshot.reviewDecision === "changes_requested" ? (
            <span className="text-warning-foreground">Changes requested</span>
          ) : snapshot.reviewDecision === "review_required" ? (
            <span className="text-muted-foreground">Review required</span>
          ) : null}
        </span>
      ) : null}
    </RowWithMenu>
  );
}

function IssueRow({ link, onRemove }: { link: Extract<TaskLink, { kind: "issue" }>; onRemove: () => void }) {
  const snapshot = link.snapshot;
  const state = snapshot ? ISSUE_STATE[snapshot.state] : null;
  const title = snapshot?.title ?? link.label ?? link.ref.repo;
  return (
    <RowWithMenu
      href={link.url}
      title={state ? `${state.label} issue · ${link.url}` : link.url}
      menu={
        <>
          <MenuItem onClick={() => copyToClipboard(link.url, "URL")}>
            <CopyIcon />
            Copy URL
          </MenuItem>
          <RemoveItem onRemove={onRemove} />
        </>
      }
    >
      <CircleDotIcon className={cn("size-4 shrink-0", state?.tone ?? "text-muted-foreground")} />
      <span className="shrink-0 tabular-nums text-muted-foreground">#{link.ref.number}</span>
      <span className={cn(PANEL_LABEL_CLASS, "flex-1")}>{title}</span>
      {state ? <span className={cn("shrink-0 text-xs font-normal", state.tone)}>{state.label}</span> : null}
    </RowWithMenu>
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

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex" aria-label={label} />}>{children}</TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function AddLinkPopover({
  taskId,
  jiraBaseUrl,
  t3,
}: {
  taskId: string;
  jiraBaseUrl: string | null;
  t3: T3IntegrationStatus;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const { mutate: addLink, isPending } = useAddLink();
  const classified = classifyLink(value, { jiraBaseUrl, t3 });
  const preview = describeLinkInput(classified);
  const PreviewIcon = preview ? LINK_KIND_ICON[preview.kind] : null;

  const submit = () => {
    if (!classified || isPending) return;
    addLink(
      { taskId, value: value.trim() },
      {
        onSuccess: () => {
          setValue("");
          setOpen(false);
        },
      },
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setValue("");
      }}
    >
      <PopoverTrigger render={<PanelControl part="row" tone="muted" />}>
        <PlusIcon className={PANEL_ICON_CLASS} />
        <span className={PANEL_LABEL_CLASS}>Add link</span>
      </PopoverTrigger>
      <PopoverPopup align="start" width="md" padding="compact">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            autoFocus
            aria-label="Link"
            size="sm"
            value={value}
            placeholder="Paste a PR, Jira key, T3 thread or URL"
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <div className="flex min-h-5 items-center gap-1.5 text-xs text-muted-foreground">
            {preview && PreviewIcon ? (
              <>
                <PreviewIcon className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate text-foreground/80">{preview.label}</span>
                <span className="ms-auto shrink-0">Enter to add</span>
              </>
            ) : value.trim() ? (
              <span>{unrecognisedLinkHint(value, t3)}</span>
            ) : (
              <span>Detects GitHub PRs, Jira keys, T3 Code threads and URLs.</span>
            )}
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}
