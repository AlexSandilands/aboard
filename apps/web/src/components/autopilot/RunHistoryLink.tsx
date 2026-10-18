import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";

/**
 * Opens the run history page of an automation (`AUTOPILOT_ALL_RUNS` for every automation's). Marked as opened from
 * Settings, so the page's Back steps back instead of stacking another entry.
 */
export function RunHistoryLink({ automation, label = "View all runs" }: { automation: string; label?: string }) {
  const navigate = useNavigate();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        void navigate({
          to: "/settings/autopilot/runs/$automation",
          params: { automation },
          state: FROM_SETTINGS_LIST,
        })
      }
    >
      <HistoryIcon />
      {label}
    </Button>
  );
}
