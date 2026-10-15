import { reviewBadgeLabel, type TaskReviewSummary } from "@repo/contracts";
import { Badge } from "~/components/ui/badge";
import { reviewBadgeVariant } from "./review.logic";

/** Describes the badge for its tooltip: the label alone hides how many rounds it took. */
function reviewTitle(summary: TaskReviewSummary): string {
  const open = Object.entries(summary.open)
    .filter(([, n]) => n > 0)
    .map(([severity, n]) => `${n} ${severity}`);
  return [
    `Local review: ${reviewBadgeLabel(summary)}`,
    `Round ${summary.round} of ${summary.maxRounds}`,
    open.length ? `Open: ${open.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The card's local review state. */
export function ReviewBadge({ summary }: { summary: TaskReviewSummary }) {
  return (
    <Badge variant={reviewBadgeVariant(summary)} size="sm" title={reviewTitle(summary)}>
      {reviewBadgeLabel(summary)}
    </Badge>
  );
}
