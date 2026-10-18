import { AUTOPILOT_ORCHESTRATE, AUTOPILOT_RECURRING, type AutopilotScopeEntry } from "@repo/contracts";
import { CalendarClockIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { PopoverClose } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { useSetAutopilotPaused, type useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { entryFor, scopeAutomations, scopeRowModel } from "./autopilot.logic";
import { OrchestrateSection } from "./OrchestrateSection";
import { PausedNotice, ScopeCard, ScopeRow, ScopeSectionLabel, ScopeSkeleton } from "./ScopeRow";

/**
 * The popover behind the lane pill and the epic button: an on/off switch per automation for one scope, faded while it
 * follows the scope above (the board for a project, the project for an epic) and solid once this scope sets it.
 * A project's popover pins Orchestrate in a card of its own at the top (OrchestrateSection). `children` are further
 * cards under the automations (an epic's delivery).
 */
export function ScopePopover({
  title,
  entries,
  set,
  projectId,
  epic = false,
  error,
  children,
}: {
  /** The project's or epic's name, for the switches' labels. */
  title: string;
  entries: ReadonlyArray<AutopilotScopeEntry> | undefined;
  set: ReturnType<typeof useSetAutopilotScope>;
  /** Set for a project's popover: Recurring tasks gets a link to the project's settings page at that section. */
  projectId?: string;
  /** An epic's popover: leaves out the automations that don't apply to epics. */
  epic?: boolean;
  /** The scope query's error, so a failed load shows a message instead of a skeleton for good. */
  error?: Error | null;
  children?: ReactNode;
}) {
  const overview = useAutopilotOverview();
  const openSettings = useOpenSettings();
  const resume = useSetAutopilotPaused();
  const paused = overview.data?.paused ?? false;
  const automations = scopeAutomations(overview.data?.automations ?? [], epic);
  const pinned = projectId && !epic ? automations.find((a) => a.key === AUTOPILOT_ORCHESTRATE) : undefined;
  const scope = epic ? "epic" : "project";
  // The switches would show a made-up Off until the scope arrives, so rows wait for it.
  const loading = !overview.data || !entries;
  const loadError = error ?? overview.error;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Autopilot</h3>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverClose
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Autopilot settings"
                    onClick={() => openSettings("autopilot")}
                  />
                }
              />
            }
          >
            <SettingsIcon />
          </TooltipTrigger>
          <TooltipPopup>Autopilot settings</TooltipPopup>
        </Tooltip>
      </div>
      {paused ? <PausedNotice disabled={resume.isPending} onResume={() => resume.mutate(false)} /> : null}
      {loading && loadError ? (
        <p role="alert" className="text-2xs text-destructive-foreground">
          Couldn't load Autopilot: {loadError.message}
        </p>
      ) : loading ? (
        <ScopeSkeleton />
      ) : (
        <>
          {pinned && projectId ? (
            <OrchestrateSection
              automation={pinned}
              entry={entryFor(entries, pinned)}
              title={title}
              projectId={projectId}
              set={set}
            />
          ) : null}
          <ScopeSectionLabel>Automations</ScopeSectionLabel>
          <ScrollArea scrollFade className="max-h-72">
            <ScopeCard>
              {automations
                .filter((automation) => automation !== pinned)
                .map((automation) => (
                  <ScopeRow
                    key={automation.key}
                    name={automation.title}
                    description={automation.description}
                    label={`${automation.title} in ${title}`}
                    model={scopeRowModel(entryFor(entries, automation), automation.blocked, scope)}
                    scope={scope}
                    disabled={set.isPending}
                    onChange={(mode) => set.mutate({ automation: automation.key, mode })}
                    trailing={
                      projectId && automation.key === AUTOPILOT_RECURRING ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <PopoverClose
                                render={
                                  <Button
                                    size="icon-micro"
                                    variant="ghost-muted"
                                    aria-label="Recurring tasks settings"
                                    onClick={() => openSettings("project.recurring", { project: projectId })}
                                  />
                                }
                              />
                            }
                          >
                            <CalendarClockIcon />
                          </TooltipTrigger>
                          <TooltipPopup side="top">Recurring tasks</TooltipPopup>
                        </Tooltip>
                      ) : null
                    }
                  />
                ))}
            </ScopeCard>
          </ScrollArea>
        </>
      )}
      {children}
    </div>
  );
}
