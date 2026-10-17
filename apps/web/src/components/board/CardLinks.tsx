import {
  prMergeAction,
  type PrRowSlot,
  type PrSnapshot,
  type T3ThreadStatus,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  Link2Icon,
  MessagesSquareIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { SyntheticEvent } from "react";
import { FixInMenuItems, usePrSlot } from "~/components/handoff/FixPrMenu";
import { PR_AUTOPILOT_LABEL } from "~/components/handoff/fixPr.logic";
import { mergeButtonLabel } from "~/components/merge/merge.logic";
import { HarnessIcon, SessionMenuItems } from "~/components/sessions/SessionParts";
import { sessionStatusPresentation, sessionTitle, type SessionLink } from "~/components/sessions/sessions.logic";
import { useSessionActions } from "~/components/sessions/useSessionActions";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { t3LinkTargets } from "~/lib/t3Links";
import { cn } from "~/lib/utils";
import { useDialogs } from "~/state/ui";
import { useBoardContext } from "./BoardContext";
import { cardLinks } from "./cardLinks.logic";

// PR state colours from T3 Code's pullRequestIcons.tsx (MIT) — see NOTICE.
const PR_STATE: Record<PrSnapshot["state"], { label: string; tone: string; Icon: LucideIcon }> = {
  open: { label: "Open", tone: "text-emerald-600 dark:text-emerald-300/90", Icon: GitPullRequestArrowIcon },
  draft: { label: "Draft", tone: "text-zinc-500 dark:text-zinc-400/80", Icon: GitPullRequestDraftIcon },
  closed: { label: "Closed", tone: "text-red-600 dark:text-red-300/90", Icon: GitPullRequestClosedIcon },
  merged: { label: "Merged", tone: "text-violet-600 dark:text-violet-300/90", Icon: GitMergeIcon },
};

const CHECKS: Record<Exclude<PrSnapshot["checks"], "none">, { label: string; dot: string }> = {
  failing: { label: "Checks failing", dot: "bg-red-500" },
  pending: { label: "Checks pending", dot: "bg-amber-500" },
  passing: { label: "Checks passing", dot: "bg-emerald-500" },
};

export const THREAD_STATUS: Record<T3ThreadStatus, { label: string; dot: string }> = {
  working: { label: "Working", dot: "bg-primary" },
  waiting: { label: "Waiting", dot: "bg-muted-foreground/60" },
  input: { label: "Needs input", dot: "bg-warning" },
  approval: { label: "Needs approval", dot: "bg-warning" },
  failed: { label: "Failed", dot: "bg-error" },
  done: { label: "Done", dot: "bg-success" },
  idle: { label: "Idle", dot: "bg-muted-foreground/40" },
};

export const chipClassName =
  "inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Links inside a card must not open the panel or start a drag. */
const stop = (event: SyntheticEvent) => event.stopPropagation();
export const linkHandlers = { onClick: stop, onPointerDown: stop, onKeyDown: stop };

export function hasCardLinks(links: ReadonlyArray<TaskLink>): boolean {
  return cardLinks(links).length > 0;
}

/**
 * Card line 4: PR chips (with the one action the PR offers: merge, fix in a session, or Autopilot's state), "Open in T3
 * Code" buttons for active threads and agent sessions, whose menu opens them in a terminal.
 */
export function CardLinks({ task }: { task: TaskSummary }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {cardLinks(task.links).map((link) =>
        link.kind === "pr" ? (
          <PrChip key={link.id} task={task} link={link} />
        ) : link.kind === "t3_thread" ? (
          <ThreadButton key={link.id} link={link} />
        ) : link.kind === "agent_session" ? (
          <SessionChip key={link.id} taskId={task.id} link={link} />
        ) : null,
      )}
    </div>
  );
}

function PrChip({ task, link }: { task: TaskSummary; link: Extract<TaskLink, { kind: "pr" }> }) {
  const snapshot = link.snapshot;
  const mergeAction = prMergeAction(task.status, snapshot);
  const slot = usePrSlot(task, link);
  const state = snapshot ? PR_STATE[snapshot.state] : null;
  const Icon = state?.Icon ?? Link2Icon;
  const checks = snapshot && snapshot.checks !== "none" ? CHECKS[snapshot.checks] : null;
  const number = link.ref?.number;
  const chip = (
    <Tooltip>
      <TooltipTrigger
        render={<a href={link.url} target="_blank" rel="noreferrer" className={chipClassName} {...linkHandlers} />}
      >
        <Icon aria-hidden className={cn("size-3.5 shrink-0", state?.tone)} />
        <span className="tabular-nums">{number !== undefined ? `#${number}` : "PR"}</span>
        {checks ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", checks.dot)} /> : null}
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex flex-col gap-0.5">
          <span>{snapshot?.title ?? link.label ?? link.url}</span>
          {state || checks ? (
            <span className="text-muted-foreground">{[state?.label, checks?.label].filter(Boolean).join(" · ")}</span>
          ) : null}
          {mergeAction === "armed" ? <span className="text-muted-foreground">Auto-merge on</span> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
  const { primary } = slot;
  if (!primary) return chip;
  return (
    <>
      {chip}
      {primary.kind === "merge" ? (
        <MergeChip taskId={task.id} linkId={link.id} label={mergeButtonLabel(primary.action)} />
      ) : (
        <FixChip task={task} link={link} slot={slot} />
      )}
    </>
  );
}

/** "Fix in →" on a card, or Autopilot's state with Fix in → in its menu; the menu also holds the Merge that gave way. */
function FixChip({
  task,
  link,
  slot,
}: {
  task: TaskSummary;
  link: Extract<TaskLink, { kind: "pr" }>;
  slot: PrRowSlot;
}) {
  const openMergePr = useDialogs((s) => s.openMergePr);
  const autopilot = slot.primary?.kind === "autopilot" ? slot.primary.state : null;
  const label = autopilot ? `${PR_AUTOPILOT_LABEL[autopilot]}: fix it in a session instead` : "Fix in a session";
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  className={cn(
                    chipClassName,
                    "data-popup-open:bg-accent",
                    !autopilot && "text-primary hover:text-primary",
                  )}
                  {...linkHandlers}
                />
              }
            />
          }
        >
          {autopilot === "fixing" ? (
            <Spinner size="xs" aria-hidden role="presentation" />
          ) : autopilot === "gave_up" ? (
            <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
          ) : (
            <WrenchIcon aria-hidden className="size-3.5 shrink-0" />
          )}
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...linkHandlers}>
        <FixInMenuItems task={task} link={link} />
        {slot.menu.merge ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => openMergePr(task.id, link.id)}>
              <GitMergeIcon />
              {mergeButtonLabel(slot.menu.merge)}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function MergeChip({ taskId, linkId, label }: { taskId: string; linkId: string; label: string }) {
  const openMergePr = useDialogs((s) => s.openMergePr);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            className={cn(chipClassName, "text-primary hover:text-primary")}
            {...linkHandlers}
            onClick={(event) => {
              event.stopPropagation();
              openMergePr(taskId, linkId);
            }}
          />
        }
      >
        <GitMergeIcon aria-hidden className="size-3.5 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function ThreadButton({ link }: { link: Extract<TaskLink, { kind: "t3_thread" }> }) {
  const { t3, settings } = useBoardContext();
  const target = t3LinkTargets(link.ref, t3, settings).primary;
  const status = link.snapshot ? THREAD_STATUS[link.snapshot.status] : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<a href={target.href} aria-label={target.label} className={chipClassName} {...linkHandlers} />}
      >
        <MessagesSquareIcon aria-hidden className="size-3.5 shrink-0" />
        {status ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dot)} /> : null}
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex flex-col gap-0.5">
          <span>{link.snapshot?.title ?? link.label ?? "T3 Code thread"}</span>
          <span className="text-muted-foreground">{status ? `${status.label} · ${target.label}` : target.label}</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function SessionChip({ taskId, link }: { taskId: string; link: SessionLink }) {
  const { open } = useSessionActions(taskId);
  const status = sessionStatusPresentation(link.snapshot);
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`${sessionTitle(link)}: ${status.label}`}
                  className={chipClassName}
                  {...linkHandlers}
                />
              }
            />
          }
        >
          <HarnessIcon harness={link.ref.harness} />
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.dotClass)} />
        </TooltipTrigger>
        <TooltipPopup>
          <span className="flex flex-col gap-0.5">
            <span>{sessionTitle(link)}</span>
            <span className="text-muted-foreground">{status.label}</span>
          </span>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...linkHandlers}>
        <SessionMenuItems link={link} onOpen={(mode) => open(link, mode)} />
      </MenuPopup>
    </Menu>
  );
}
