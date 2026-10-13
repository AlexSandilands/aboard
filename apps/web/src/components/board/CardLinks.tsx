import type { PrSnapshot, T3ThreadStatus, TaskLink } from "@repo/contracts";
import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  Link2Icon,
  MessagesSquareIcon,
  type LucideIcon,
} from "lucide-react";
import type { SyntheticEvent } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { t3LinkTargets } from "~/lib/t3Links";
import { cn } from "~/lib/utils";
import { useBoardContext } from "./BoardContext";

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

const THREAD_STATUS: Record<T3ThreadStatus, { label: string; dot: string }> = {
  working: { label: "Working", dot: "bg-primary" },
  waiting: { label: "Waiting", dot: "bg-muted-foreground/60" },
  input: { label: "Needs input", dot: "bg-warning" },
  approval: { label: "Needs approval", dot: "bg-warning" },
  failed: { label: "Failed", dot: "bg-error" },
  done: { label: "Done", dot: "bg-success" },
  idle: { label: "Idle", dot: "bg-muted-foreground/40" },
};

const chipClassName =
  "inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** Links inside a card must not open the panel or start a drag. */
const stop = (event: SyntheticEvent) => event.stopPropagation();
const linkHandlers = { onClick: stop, onPointerDown: stop, onKeyDown: stop };

export function hasCardLinks(links: ReadonlyArray<TaskLink>): boolean {
  return links.some((link) => link.kind === "pr" || link.kind === "t3_thread");
}

/** Card line 4: PR chips and "Open in T3 Code" thread buttons. */
export function CardLinks({ links }: { links: ReadonlyArray<TaskLink> }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {links.map((link) =>
        link.kind === "pr" ? <PrChip key={link.id} link={link} /> : link.kind === "t3_thread" ? <ThreadButton key={link.id} link={link} /> : null,
      )}
    </div>
  );
}

function PrChip({ link }: { link: Extract<TaskLink, { kind: "pr" }> }) {
  const snapshot = link.snapshot;
  const state = snapshot ? PR_STATE[snapshot.state] : null;
  const Icon = state?.Icon ?? Link2Icon;
  const checks = snapshot && snapshot.checks !== "none" ? CHECKS[snapshot.checks] : null;
  const number = link.ref?.number;
  return (
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
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function ThreadButton({ link }: { link: Extract<TaskLink, { kind: "t3_thread" }> }) {
  const { t3, settings } = useBoardContext();
  const target = t3LinkTargets(link.ref, t3, settings).primary;
  const status = link.snapshot ? THREAD_STATUS[link.snapshot.status] : null;
  return (
    <Tooltip>
      <TooltipTrigger render={<a href={target.href} aria-label={target.label} className={chipClassName} {...linkHandlers} />}>
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
