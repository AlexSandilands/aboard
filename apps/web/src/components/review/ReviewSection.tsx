import { reviewBadgeLabel, type ReviewFinding, type TaskDetail, type TaskReview } from "@repo/contracts";
import { CheckIcon, CopyIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Markdown } from "~/components/markdown/Markdown";
import { copyToClipboard, InlineInput } from "~/components/task/InlineInput";
import { PanelControl, ROW_HOVER_ACTION_CLASS } from "~/components/task/PanelControl";
import { TaskSection } from "~/components/task/TaskSection";
import { Badge } from "~/components/ui/badge";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { fetchReviewPrompt, useResolveFinding, useStartReview, useUpdateTask } from "~/state/mutations";
import { useSettings } from "~/state/queries";
import {
  autoReviewChoice,
  autoReviewOptions,
  autoReviewValue,
  findingLocation,
  reviewBadgeVariant,
  SEVERITY_VARIANT,
  sortFindings,
  visibleFindings,
} from "./review.logic";

const STATUS_LABEL: Record<ReviewFinding["status"], string> = { open: "Open", fixed: "Fixed", wont_fix: "Won't fix" };

/**
 * The task's local review: the per-task auto-review override, actions to run a review or copy the loop
 * prompt, the latest round's findings and anything still open from earlier rounds.
 */
export function ReviewSection({ task }: { task: TaskDetail }) {
  const settings = useSettings().data;
  const { mutate: updateTask } = useUpdateTask();
  const { mutate: startReview, isPending: starting } = useStartReview();
  // Closed tasks only keep the section when there's a history to show.
  if (task.resolution && task.reviews.length === 0) return null;

  const options = autoReviewOptions(settings?.autoReview ?? false);
  const latest = task.reviews.at(-1);
  const earlierOpen = task.reviews.slice(0, -1).flatMap((r) => visibleFindings(r, false));
  const effectiveOn = task.autoReview ?? settings?.autoReview ?? false;

  return (
    <TaskSection
      title="Local review"
      actions={
        <>
          <Select
            items={options}
            value={autoReviewChoice(task.autoReview)}
            onValueChange={(value) => {
              if (value) updateTask({ id: task.id, autoReview: autoReviewValue(value) });
            }}
          >
            <SelectTrigger variant="ghost" size="xs" aria-label="Auto-review for this task">
              <span className="text-muted-foreground">Auto:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false} matchTriggerWidth={false}>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <PanelControl
            part="meta"
            title="Copy the review loop prompt, to run it in any agent session"
            onClick={() =>
              void fetchReviewPrompt(task.id).then(
                (prompt) => copyToClipboard(prompt, "review prompt"),
                (error: unknown) =>
                  toastManager.add({
                    type: "error",
                    title: "Couldn't load the review prompt",
                    description: error instanceof Error ? error.message : String(error),
                  }),
              )
            }
          >
            <CopyIcon className="size-3.5" />
            Copy prompt
          </PanelControl>
          <PanelControl
            part="meta"
            title="Open a new review round; an agent or the board's fallbacks pick it up"
            disabled={starting || latest?.status === "pending" || latest?.status === "running"}
            onClick={() => startReview(task.id)}
          >
            <PlayIcon className="size-3.5" />
            Run review
          </PanelControl>
        </>
      }
    >
      {latest && task.review ? (
        <div className="flex flex-col gap-1 px-1.5">
          <RoundHeader review={latest} badge={task.review} />
          {latest.findings.length === 0 && latest.status === "submitted" ? (
            <p className="px-1 py-1 text-xs text-muted-foreground">No findings.</p>
          ) : null}
          <FindingList taskId={task.id} findings={sortFindings(latest.findings)} />
          {earlierOpen.length ? (
            <>
              <p className="px-1 pt-2 text-2xs font-medium text-muted-foreground">Still open from earlier rounds</p>
              <FindingList taskId={task.id} findings={sortFindings(earlierOpen)} />
            </>
          ) : null}
        </div>
      ) : (
        <p className="px-3 pb-1 text-xs text-muted-foreground">
          {effectiveOn
            ? "Not reviewed yet. A review round opens when the task moves to Review."
            : "Not reviewed yet. Turn auto-review on, or run a review now."}
        </p>
      )}
    </TaskSection>
  );
}

function RoundHeader({ review, badge }: { review: TaskReview; badge: NonNullable<TaskDetail["review"]> }) {
  return (
    <div className="flex flex-col gap-1 px-1 pb-1">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Badge variant={reviewBadgeVariant(badge)} size="sm">
          {reviewBadgeLabel(badge)}
        </Badge>
        <span className="truncate text-muted-foreground">
          Round {review.round} · {badge.round} of {badge.maxRounds} this cycle
          {review.reviewer ? ` · ${review.reviewer}` : ""}
          {review.skill ? ` · ${review.skill}` : ""}
        </span>
      </div>
      {review.summary ? <Markdown size="xs">{review.summary}</Markdown> : null}
      {review.error ? <p className="text-xs text-destructive-foreground">{review.error}</p> : null}
    </div>
  );
}

function FindingList({ taskId, findings }: { taskId: string; findings: ReadonlyArray<ReviewFinding> }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {findings.map((f) => (
        <FindingRow key={f.id} taskId={taskId} finding={f} />
      ))}
    </ul>
  );
}

function FindingRow({ taskId, finding }: { taskId: string; finding: ReviewFinding }) {
  const { mutate: resolve, isPending } = useResolveFinding();
  const [expanded, setExpanded] = useState(finding.status === "open");
  const [declining, setDeclining] = useState(false);
  const location = findingLocation(finding);
  const open = finding.status === "open";
  const hasDetail = Boolean(finding.body || finding.suggestion || finding.resolutionNote);
  const set = (status: ReviewFinding["status"], note?: string) =>
    resolve({ taskId, finding: finding.id, status, ...(note ? { note } : {}) });

  return (
    <li className="group/row rounded-lg px-1 py-1 hover:bg-black/[0.035] dark:hover:bg-white/[0.05]">
      <div className="flex min-w-0 items-start gap-1.5">
        <Badge variant={SEVERITY_VARIANT[finding.severity]} size="sm" className="mt-0.5 capitalize">
          {finding.severity}
        </Badge>
        <button
          type="button"
          className={cn(
            "min-w-0 flex-1 text-left text-[13px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-ring",
            open ? "text-foreground/90" : "text-muted-foreground line-through decoration-muted-foreground/40",
          )}
          aria-expanded={hasDetail ? expanded : undefined}
          onClick={() => hasDetail && setExpanded((e) => !e)}
        >
          <span className="me-1.5 font-mono text-2xs text-muted-foreground">{finding.label}</span>
          {finding.title}
          {location ? <span className="ms-1.5 font-mono text-2xs text-muted-foreground">{location}</span> : null}
        </button>
        {!open ? (
          <Badge variant="outline" size="sm" className="mt-0.5">
            {STATUS_LABEL[finding.status]}
          </Badge>
        ) : null}
        <div className={cn("flex shrink-0 items-center", ROW_HOVER_ACTION_CLASS)}>
          {open ? (
            <>
              <PanelControl part="icon" title="Mark fixed" disabled={isPending} onClick={() => set("fixed")}>
                <CheckIcon className="size-3.5" />
              </PanelControl>
              <PanelControl part="icon" title="Won't fix…" disabled={isPending} onClick={() => setDeclining(true)}>
                <XIcon className="size-3.5" />
              </PanelControl>
            </>
          ) : (
            <PanelControl part="icon" title="Reopen" disabled={isPending} onClick={() => set("open")}>
              <RotateCcwIcon className="size-3.5" />
            </PanelControl>
          )}
        </div>
      </div>
      {declining ? (
        <div className="mt-1 ps-1">
          <InlineInput
            value=""
            placeholder="Why won't this be fixed?"
            ariaLabel={`Reason for not fixing ${finding.label}`}
            onCommit={(note) => {
              setDeclining(false);
              set("wont_fix", note);
            }}
            onCancel={() => setDeclining(false)}
          />
        </div>
      ) : null}
      {expanded && hasDetail ? (
        <div className="mt-1 flex flex-col gap-1 ps-1 text-muted-foreground">
          {finding.body ? <Markdown size="xs">{finding.body}</Markdown> : null}
          {finding.suggestion ? <Markdown size="xs">{`**Suggestion:** ${finding.suggestion}`}</Markdown> : null}
          {finding.resolutionNote ? (
            <Markdown size="xs">{`**${STATUS_LABEL[finding.status]}${finding.resolvedBy ? ` by ${finding.resolvedBy}` : ""}:** ${finding.resolutionNote}`}</Markdown>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
