import type { AutopilotScopeEntry } from "@repo/contracts";
import { PopoverClose } from "~/components/ui/popover";
import type { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { entryFor, inheritLabel, parentEntry } from "./autopilot.logic";
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
}: {
  /** The project's or epic's name, for the switches' labels. */
  title: string;
  entries: ReadonlyArray<AutopilotScopeEntry> | undefined;
  parentEntries: ReadonlyArray<AutopilotScopeEntry> | undefined;
  set: ReturnType<typeof useSetAutopilotScope>;
}) {
  const overview = useAutopilotOverview();
  const paused = overview.data?.paused ?? false;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Autopilot</h3>
        <PopoverClose
          className="cursor-pointer rounded-sm text-2xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => useDialogs.getState().setAppSettingsOpen(true)}
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
        {(overview.data?.automations ?? []).map((automation) => {
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
                <span className="min-w-0 truncate text-2xs text-muted-foreground" title="What Inherit resolves to">
                  {inheritLabel(parent)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
