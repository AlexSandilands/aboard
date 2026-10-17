import { AUTOPILOT_RECURRING, type AutopilotScopeEntry } from "@repo/contracts";
import { PopoverClose } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import type { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { entryFor, inheritLabel, parentEntry, scopeAutomations } from "./autopilot.logic";
import { ModeSwitch } from "./ModeSwitch";

/**
 * The popover behind the lane pill and the epic button: Inherit / On / Off per automation for one scope, each saying
 * what Inherit would be. `parentEntries` are the scope above's (the board's for a project, the project's for an epic).
 */
export function ScopePopover({
  title,
  entries,
  parentEntries,
  set,
  projectId,
  epic = false,
}: {
  /** The project's or epic's name, for the switches' labels. */
  title: string;
  entries: ReadonlyArray<AutopilotScopeEntry> | undefined;
  parentEntries: ReadonlyArray<AutopilotScopeEntry> | undefined;
  set: ReturnType<typeof useSetAutopilotScope>;
  /** Set for a project's popover: under Recurring tasks a link opens the project's settings page at that section. */
  projectId?: string;
  /** An epic's popover: leaves out the automations that don't apply to epics. */
  epic?: boolean;
}) {
  const overview = useAutopilotOverview();
  const openSettings = useOpenSettings();
  const paused = overview.data?.paused ?? false;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Autopilot</h3>
        <PopoverClose
          className="cursor-pointer rounded-sm text-2xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openSettings("autopilot")}
        >
          Settings
        </PopoverClose>
      </div>
      {paused ? (
        <p className="rounded-md bg-warning/8 px-2 py-1 text-2xs text-warning-foreground">
          Paused: no new runs start. Runs already going finish.
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border/50">
        {scopeAutomations(overview.data?.automations ?? [], epic).map((automation) => {
          const entry = entryFor(entries, automation);
          const parent = parentEntry(parentEntries, automation.key);
          return (
            <li key={automation.key} className="flex flex-col gap-1.5 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{automation.title}</p>
                <p className="line-clamp-2 text-2xs text-muted-foreground">{automation.description}</p>
              </div>
              <div className="flex items-center justify-between gap-2">
                <ModeSwitch
                  label={`${automation.title} in ${title}`}
                  value={entry.mode}
                  disabled={set.isPending}
                  onChange={(mode) => set.mutate({ automation: automation.key, mode })}
                />
                <span
                  className={cn(
                    "min-w-0 truncate text-2xs",
                    entry.mode === "inherit" && parent?.enabled ? "text-info-foreground" : "text-muted-foreground",
                  )}
                  title="What Inherit resolves to"
                >
                  {inheritLabel(parent)}
                </span>
              </div>
              {projectId && automation.key === AUTOPILOT_RECURRING ? (
                <PopoverClose
                  className="w-fit cursor-pointer rounded-sm text-2xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => openSettings("project.recurring", { project: projectId })}
                >
                  Recurring tasks…
                </PopoverClose>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
