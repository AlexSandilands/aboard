import { AUTOPILOT_ORCHESTRATE } from "@repo/contracts";
import { SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { PopoverClose } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useOpenSettings } from "~/components/settings/settingsNavigation";
import { useSetAutopilotPaused } from "~/state/mutations";
import { useAutopilotOverview } from "~/state/queries";
import { scopeAutomations } from "./autopilot.logic";
import { OrchestrateSection } from "./OrchestrateSection";
import type { PopoverScope } from "./where.logic";
import { PausedNotice, ScopeCard, ScopeSectionLabel, ScopeSkeleton } from "./ScopeRow";
import { WhereRow } from "./WhereRow";

/**
 * The popover behind the lane pill and the epic button: the compact form of the Where it runs widget. One row per
 * automation with a switch for this project or epic and a line saying where it runs overall, so an exception made here
 * shows in Settings and the other way round. A project's popover pins Orchestrate in a card of its own at the top
 * (OrchestrateSection). `children` are further cards under the automations (an epic's delivery).
 */
export function ScopePopover({
  title,
  scope,
  error,
  children,
}: {
  /** The project's or epic's name, for the switches' labels. */
  title: string;
  /** A project's popover pins Orchestrate; an epic's leaves out the automations that don't apply to epics. */
  scope: PopoverScope;
  /** The load error, so a failed load shows a message instead of a skeleton for good. */
  error?: Error | null;
  children?: ReactNode;
}) {
  const overview = useAutopilotOverview();
  const openSettings = useOpenSettings();
  const resume = useSetAutopilotPaused();
  const paused = overview.data?.paused ?? false;
  const automations = scopeAutomations(overview.data?.automations ?? [], scope.kind === "epic");
  const projectId = scope.kind === "project" ? scope.id : undefined;
  const pinned = projectId ? automations.find((a) => a.key === AUTOPILOT_ORCHESTRATE) : undefined;
  const loading = !overview.data;
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
                    onClick={() => openSettings("autopilot", projectId ? { project: projectId } : {})}
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
          {pinned && projectId ? <OrchestrateSection automation={pinned} title={title} projectId={projectId} /> : null}
          <ScopeSectionLabel>Automations</ScopeSectionLabel>
          <ScrollArea scrollFade className="max-h-72">
            <ScopeCard>
              {automations
                .filter((automation) => automation !== pinned)
                .map((automation) => (
                  <WhereRow key={automation.key} automation={automation} scope={scope} title={title} />
                ))}
            </ScopeCard>
          </ScrollArea>
        </>
      )}
      {children}
    </div>
  );
}
