import { epicBranchName, startedEpicTasks, type EpicDelivery, type TaskSummary } from "@repo/contracts";
import { GitBranchIcon } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useSetEpicDelivery } from "~/state/mutations";
import { useBoard } from "~/state/queries";

type EpicLike = Pick<TaskSummary, "id" | "number" | "title" | "kind" | "delivery" | "integrationBranch" | "archivedAt">;

const OPTIONS: ReadonlyArray<{ value: EpicDelivery; label: string }> = [
  { value: "main", label: "Pull requests to main" },
  { value: "integration", label: "Integration branch" },
];

/** What the delivery means for the epic, in a line. */
export function deliveryDescription(epic: EpicLike): string {
  return epic.integrationBranch
    ? `Tasks start from ${epic.integrationBranch} and open their pull requests against it. Autopilot's Merge into epic branch merges them there; you merge the epic's pull request into main.`
    : "Each task opens a pull request to the default branch, and you merge it.";
}

/**
 * How the epic's tasks are delivered: pull requests to main, or an integration branch of the epic's own. Switching to
 * the integration branch makes it on origin (`epic/<n>-<slug>`); going back is refused once a task has started.
 */
export function EpicDeliveryControl({ epic }: { epic: EpicLike }) {
  const set = useSetEpicDelivery(epic.id);
  const board = useBoard();
  const started = startedEpicTasks((board.data?.tasks ?? []).filter((t) => t.parent?.id === epic.id));
  // Nothing is pressed until someone chooses, so choosing main is saved too (and agents stop asking).
  const value: EpicDelivery | null = epic.integrationBranch ? "integration" : epic.delivery;
  const locked = value === "integration" && started.length > 0;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">Delivery</h3>
      <ToggleGroup
        aria-label={`Delivery of epic #${epic.number}`}
        disabled={set.isPending || locked}
        value={value ? [value] : []}
        onValueChange={(next) => {
          const delivery = next[0];
          if ((delivery === "main" || delivery === "integration") && delivery !== value) set.mutate(delivery);
        }}
      >
        {OPTIONS.map((option) => (
          <Toggle key={option.value} value={option.value}>
            {option.label}
          </Toggle>
        ))}
      </ToggleGroup>
      <p className="text-2xs text-muted-foreground">
        {set.isPending && set.variables === "integration"
          ? `Making ${epicBranchName(epic)} on origin…`
          : deliveryDescription(epic)}
      </p>
      {locked ? (
        <p className="text-2xs text-muted-foreground">
          {started.map((t) => `#${t.number}`).join(", ")} already started from the branch, so the epic finishes through
          it.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The board's mark on an epic that delivers through an integration branch (nothing for one delivering to main). The
 * tooltip names the branch; a click opens the same delivery popover as the panel's button.
 */
export function EpicBranchBadge({ epic, className }: { epic: EpicLike; className?: string }) {
  if (epic.kind !== "epic" || !epic.integrationBranch) return null;
  const label = `Delivery: integration branch ${epic.integrationBranch}`;
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={label}
              render={
                <Badge
                  variant="info"
                  size="sm"
                  render={<button type="button" aria-label={label} />}
                  className={className}
                />
              }
            />
          }
        >
          <GitBranchIcon aria-hidden />
          integration
        </TooltipTrigger>
        <TooltipPopup>{epic.integrationBranch}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg" padding="compact">
        <EpicDeliveryControl epic={epic} />
      </PopoverPopup>
    </Popover>
  );
}

/** The panel's Delivery button, next to the epic's Autopilot button: the branch icon, lit while it has one. */
export function EpicDeliveryButton({ epic, className }: { epic: EpicLike; className?: string }) {
  if (epic.kind !== "epic" || epic.archivedAt !== null) return null;
  const label = epic.integrationBranch
    ? `Delivery: integration branch ${epic.integrationBranch}`
    : "Delivery: pull requests to main";
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={label}
              className={cn(
                "inline-flex size-5.5 shrink-0 cursor-pointer items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                epic.integrationBranch
                  ? "border-info/40 bg-info/10 text-info-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
                className,
              )}
            />
          }
        >
          <GitBranchIcon aria-hidden className="size-3" />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" width="lg" padding="compact">
        <EpicDeliveryControl epic={epic} />
      </PopoverPopup>
    </Popover>
  );
}
