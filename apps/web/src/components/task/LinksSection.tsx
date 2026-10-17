import {
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
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  ChevronDownIcon,
  CircleXIcon,
  CopyIcon,
  EllipsisIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  TicketIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useState, type FC, type ReactNode } from "react";

import { FixInMenuItems, usePrSlot } from "~/components/handoff/FixPrMenu";
import { PR_AUTOPILOT_LABEL, PR_AUTOPILOT_TITLE } from "~/components/handoff/fixPr.logic";
import { copyTaskReference } from "~/components/handoff/HandoffActions";
import { T3Icon } from "~/components/sessions/SessionParts";
import { mergeButtonLabel } from "~/components/merge/merge.logic";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  Menu,
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
import { cn } from "~/lib/utils";
import { useAddLink, useMergePr, useRefreshLink, useRemoveLink } from "~/state/mutations";
import { queryKeys, useBoard, useSettings } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { copyToClipboard } from "./InlineInput";
import {
  describeLinkInput,
  hostnameOf,
  ISSUE_STATE,
  isWebUrl,
  groupLinks,
  jiraHref,
  unrecognisedLinkHint,
  type PlainLink,
} from "./links.logic";
import {
  PANEL_ICON_CLASS,
  PANEL_LABEL_CLASS,
  PanelControl,
  PanelSplitGroup,
  ROW_HOVER_ACTION_CLASS,
} from "./PanelControl";
import { LinksSummary } from "./SectionSummaries";
import { TaskSection } from "./TaskSection";

export const T3_UNDETECTED: T3IntegrationStatus = {
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

export const LINK_KIND_ICON: Record<TaskLink["kind"], FC<{ className?: string }>> = {
  pr: GitPullRequestArrowIcon,
  jira: TicketIcon,
  t3_thread: T3Icon,
  issue: CircleDotIcon,
  agent_session: SquareTerminalIcon,
  url: GlobeIcon,
};

/** Anchor props: web URLs open in a new tab, app deep links (t3code://) in place. */
export const linkProps = (href: string) => (isWebUrl(href) ? { href, target: "_blank", rel: "noreferrer" } : { href });

/** Removes a link from the cached task right away, refetching if the server refuses. */
export function useRemoveTaskLink(taskId: string) {
  const queryClient = useQueryClient();
  const { mutate: removeLink } = useRemoveLink();
  return (linkId: string) => {
    queryClient.setQueryData<TaskDetail>(queryKeys.task(taskId), (detail) =>
      detail ? { ...detail, links: detail.links.filter((l) => l.id !== linkId) } : detail,
    );
    removeLink(linkId, { onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }) });
  };
}

/** PRs, issues, Jira keys and URLs. The task's threads and agent sessions are in the Sessions section. */
export function LinksSection({ task }: { task: TaskDetail }) {
  const board = useBoard().data;
  const settings = useSettings().data;
  const remove = useRemoveTaskLink(task.id);
  const t3 = board?.integrations.t3 ?? T3_UNDETECTED;
  const { links } = groupLinks(task.links);

  return (
    <TaskSection
      title="Links"
      summary={links.some((link) => link.kind === "pr") && <LinksSummary links={links} />}
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
        {links.map((link) => (
          <LinkRow key={link.id} task={task} link={link} settings={settings} onRemove={() => remove(link.id)} />
        ))}
        <AddLinkPopover taskId={task.id} jiraBaseUrl={settings?.jiraBaseUrl ?? null} t3={t3} />
      </div>
    </TaskSection>
  );
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

export function RemoveItem({ onRemove }: { onRemove: () => void }) {
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
  const slot = usePrSlot(task, link);
  const state = snapshot ? PR_STATE[snapshot.state] : null;
  const title = snapshot?.title ?? link.label ?? (link.ref ? link.ref.repo : (hostnameOf(link.url) ?? link.url));
  return (
    <RowWithMenu
      href={link.url}
      title={state ? `${state.label} pull request · ${link.url}` : link.url}
      action={<PrSlotAction task={task} link={link} slot={slot} />}
      menu={
        <>
          {link.ref ? (
            <MenuItem disabled={refreshing} onClick={() => refresh(link.id)}>
              <RefreshCwIcon />
              Refresh
            </MenuItem>
          ) : null}
          {slot.menu.merge ? (
            <MenuItem onClick={() => openMergePr(task.id, link.id)}>
              <GitMergeIcon />
              {mergeButtonLabel(slot.menu.merge)}
            </MenuItem>
          ) : null}
          {slot.menu.fix ? (
            <MenuSub>
              <MenuSubTrigger>
                <WrenchIcon />
                Fix in
              </MenuSubTrigger>
              <MenuSubPopup>
                <FixInMenuItems task={task} link={link} />
              </MenuSubPopup>
            </MenuSub>
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

/** The PR row's one action slot: Merge, Fix in →, or what Autopilot's Fix PRs is doing (`prRowSlot`). */
function PrSlotAction({
  task,
  link,
  slot,
}: {
  task: TaskDetail;
  link: Extract<TaskLink, { kind: "pr" }>;
  slot: ReturnType<typeof usePrSlot>;
}) {
  const openMergePr = useDialogs((s) => s.openMergePr);
  const { primary } = slot;
  switch (primary?.kind) {
    case "merge":
      return (
        <PanelControl part="meta" tone="primary" onClick={() => openMergePr(task.id, link.id)}>
          <GitMergeIcon className="size-3.5" />
          {mergeButtonLabel(primary.action)}
        </PanelControl>
      );
    case "fix":
      return (
        <Menu>
          <MenuTrigger
            render={<PanelControl part="meta" tone="primary" title="Start a session to fix this pull request" />}
          >
            <WrenchIcon className="size-3.5" />
            Fix in
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            <FixInMenuItems task={task} link={link} />
          </MenuPopup>
        </Menu>
      );
    case "autopilot":
      return (
        <Badge
          variant={primary.state === "fixing" ? "info" : "warning"}
          size="sm"
          className="me-1 shrink-0"
          title={PR_AUTOPILOT_TITLE[primary.state]}
        >
          {PR_AUTOPILOT_LABEL[primary.state]}
        </Badge>
      );
    default:
      return null;
  }
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
