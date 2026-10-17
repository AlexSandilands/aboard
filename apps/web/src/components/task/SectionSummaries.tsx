import type { AppSettings, T3IntegrationStatus, TaskDetail } from "@repo/contracts";
import type { ReactNode } from "react";

import { linkHandlers, PrStatusChip, SessionChip, ThreadButton } from "~/components/board/CardLinks";
import { useOpenTask } from "~/components/board/boardNavigation";
import { LabelChip, useLabelColors } from "~/components/labels/LabelChip";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { SessionLink } from "~/components/sessions/sessions.logic";
import type { LinkGroups, PlainLink } from "./links.logic";
import {
  limitItems,
  linkSummaryChips,
  relationChipGroups,
  SUMMARY_CHIP_LIMIT,
  type RelationChip,
} from "./sections.logic";
import { StepSegments } from "./StepVisuals";

/**
 * The rich versions of a collapsed section's one-line summary (see `summarizeSection` for the text they stand in
 * for). A section passes one to TaskSection only when there is something to show, so that falls back to the plain
 * text ("None", "Not reviewed yet", ...) otherwise.
 */

/** What is left out of a capped list of chips. */
function More({ count, label }: { count: number; label: string }) {
  if (count === 0) return null;
  return (
    <span className="shrink-0 px-0.5 text-2xs font-medium text-muted-foreground tabular-nums" title={label}>
      +{count}
    </span>
  );
}

export function LabelsSummary({ labels }: { labels: ReadonlyArray<string> }) {
  const colors = useLabelColors();
  const { shown, hidden } = limitItems(labels, SUMMARY_CHIP_LIMIT.labels);
  return (
    <>
      {shown.map((label) => (
        <LabelChip key={label} label={label} colors={colors} className="max-w-24" />
      ))}
      <More count={hidden} label={`${hidden} more ${hidden === 1 ? "label" : "labels"}`} />
    </>
  );
}

/**
 * One button per thread or session (the ones folded into a thread's menu included), each with its status dot and the
 * menu a card's chip has. A thread's button just opens it in T3 Code.
 */
export function SessionsSummary({
  rows,
  taskId,
  t3,
  settings,
}: {
  rows: ReadonlyArray<LinkGroups["sessionRows"][number] | SessionLink>;
  taskId: string;
  t3: T3IntegrationStatus;
  settings: AppSettings | undefined;
}) {
  const { shown, hidden } = limitItems(rows, SUMMARY_CHIP_LIMIT.sessions);
  return (
    <>
      {shown.map((link) =>
        link.kind === "t3_thread" ? (
          <ThreadButton key={link.id} link={link} t3={t3} settings={settings} />
        ) : (
          <SessionChip key={link.id} taskId={taskId} link={link} />
        ),
      )}
      <More count={hidden} label={`${hidden} more ${hidden === 1 ? "session" : "sessions"}`} />
    </>
  );
}

/** PRs coloured by state, then how many other links there are. Only for a task with a PR; the text says it otherwise. */
export function LinksSummary({ links }: { links: ReadonlyArray<PlainLink> }) {
  const { prs, rest } = linkSummaryChips(links);
  return (
    <>
      {prs.map((link) => (
        <PrStatusChip key={link.id} link={link} />
      ))}
      <More count={rest} label={`${rest} more ${rest === 1 ? "link" : "links"}`} />
    </>
  );
}

/** The step bar (grey to-do, blue current, green done) with the count beside it. */
export function PlanSummary({ task }: { task: TaskDetail }) {
  const { done, total } = task.progress;
  return (
    <>
      <StepSegments statuses={task.stepStatuses} className="w-16" />
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
      {task.currentStep ? (
        <span className="min-w-0 truncate text-2xs text-muted-foreground/80">
          {task.currentStep.index} {task.currentStep.title}
        </span>
      ) : null}
    </>
  );
}

const RELATION_VARIANT = { blocking: "error", done: "success", neutral: "outline" } as const;
const RELATION_HINT = { blocking: "Blocking", done: "Done", neutral: "Waiting on this task" } as const;

function RelationBadge({ chip }: { chip: RelationChip }) {
  const openTask = useOpenTask();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={RELATION_VARIANT[chip.tone]}
            size="sm"
            render={
              <button
                type="button"
                aria-label={`Open #${chip.number} ${chip.title}`}
                {...linkHandlers}
                onClick={() => void openTask(chip.id)}
              />
            }
          />
        }
      >
        <span className="tabular-nums">#{chip.number}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="flex flex-col gap-0.5">
          <span>{chip.title}</span>
          <span className="text-muted-foreground">{RELATION_HINT[chip.tone]}</span>
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** `blocked by #3 #5 · blocks #9`, the blockers red while open and green once Done. */
export function RelationsSummary({ task }: { task: TaskDetail }) {
  const groups = relationChipGroups(task);
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((group, index) => {
        const { shown, hidden } = limitItems(group.chips, SUMMARY_CHIP_LIMIT.relations);
        return (
          <GroupLabel key={group.kind} label={group.label} separated={index > 0}>
            {shown.map((chip) => (
              <RelationBadge key={chip.id} chip={chip} />
            ))}
            <More count={hidden} label={`${hidden} more`} />
          </GroupLabel>
        );
      })}
    </>
  );
}

function GroupLabel({ label, separated, children }: { label: string; separated: boolean; children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {separated ? (
        <span aria-hidden className="text-muted-foreground/50">
          ·
        </span>
      ) : null}
      <span className="text-2xs text-muted-foreground/80">{label}</span>
      {children}
    </span>
  );
}
