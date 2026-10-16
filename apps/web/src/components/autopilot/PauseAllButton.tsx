import { PauseIcon, PlayIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useSetAutopilotPaused } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotStatus } from "~/state/queries";

/**
 * Pause all in the board header: stops every new Autopilot run (runs already going finish). While paused it turns
 * into a labelled Resume, so it can't be forgotten. Hidden while there are no automations to pause.
 */
export function PauseAllButton() {
  const overview = useAutopilotOverview();
  const paused = useAutopilotStatus()?.paused ?? false;
  const { mutate, isPending } = useSetAutopilotPaused();
  if (!paused && (!overview.data || overview.data.automations.length === 0)) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          paused ? (
            <Button
              variant="outline"
              size="xs"
              className="border-warning/50 bg-warning/8 text-warning-foreground"
              disabled={isPending}
              onClick={() => mutate(false)}
            />
          ) : (
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label="Pause all Autopilot runs"
              disabled={isPending}
              onClick={() => mutate(true)}
            />
          )
        }
      >
        {paused ? (
          <>
            <PlayIcon />
            Autopilot paused · Resume
          </>
        ) : (
          <PauseIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {paused ? "Let Autopilot start runs again" : "Pause all: no new Autopilot runs start; runs going finish"}
      </TooltipPopup>
    </Tooltip>
  );
}
