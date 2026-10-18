import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";

/**
 * Opens the run history page of an automation (`AUTOPILOT_ALL_RUNS` for every automation's), filtered to `project`
 * when given. From Settings it is marked as opened from there, so the page's Back steps back instead of stacking
 * another entry; from elsewhere (the board's popover) Back goes to the Autopilot settings.
 */
export function RunHistoryLink({
  automation,
  project,
  fromSettings = true,
  label = "View all runs",
}: {
  automation: string;
  project?: string;
  fromSettings?: boolean;
  label?: string;
}) {
  const navigate = useNavigate();
  return (
    <Button
      size={fromSettings ? "sm" : "compact"}
      variant="outline"
      onClick={() =>
        void navigate({
          to: "/settings/autopilot/runs/$automation",
          params: { automation },
          search: project ? { project } : {},
          state: fromSettings ? FROM_SETTINGS_LIST : undefined,
        })
      }
    >
      <HistoryIcon />
      {label}
    </Button>
  );
}
