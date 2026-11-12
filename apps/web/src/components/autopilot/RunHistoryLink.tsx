import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";
import { useScopeParam } from "~/components/settings/SettingsScope";
import { scopeSearch } from "~/components/settings/settingsScope.logic";

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
  size = fromSettings ? "sm" : "compact",
}: {
  automation: string;
  project?: string;
  fromSettings?: boolean;
  label?: string;
  /** The button size; "xs" in a section heading, like the other heading actions. */
  size?: "xs" | "sm" | "compact";
}) {
  const navigate = useNavigate();
  const scope = useScopeParam();
  return (
    <Button
      size={size}
      variant="outline"
      onClick={() =>
        void navigate({
          to: "/settings/autopilot/runs/$automation",
          params: { automation },
          // From Settings the history follows the scope: its project filter is the same `?project=`.
          search: scopeSearch(project ?? (fromSettings ? scope : undefined)),
          state: fromSettings ? FROM_SETTINGS_LIST : undefined,
        })
      }
    >
      <HistoryIcon />
      {label}
    </Button>
  );
}
