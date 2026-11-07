// Settings → Autopilot: three tabs. Automations (what is happening, what needs you, and every automation in a split
// card), Runs (the run history) and Limits & safety (the engine's settings and the variables). Runs and Limits have
// paths of their own; the tab bar ties them together.
import {
  AUTOPILOT_ALL_RUNS,
  canRetryRun,
  limitsSummary,
  todaySummary,
  type AutopilotNeed,
  type AutopilotOverview,
} from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, FilePenLineIcon, PauseIcon, PlayIcon, XCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsSubsection,
  StatusDot,
} from "~/components/settings/settingsLayout";
import { FROM_SETTINGS_LIST, useOpenSettings } from "~/components/settings/settingsNavigation";
import { SettingsScroller, SettingsTopBar } from "~/components/settings/SettingsShell";
import { Button } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useCustomAutomations, useDismissAutomationDraft } from "~/state/customAutomations";
import { useDismissAutopilotRun, useRetryAutopilotRun, useSetAutopilotPaused } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotProjectScopes, useBoard } from "~/state/queries";
import { useScopeAutomations } from "./AutomationRows";
import { automationReach, isOffEverywhere } from "./automationList.logic";
import { AutopilotLimits } from "./AutopilotSettingsSection";
import { AutomationsSplit, customOf, type ListedAutomation } from "./AutomationsSplit";

type Tab = "automations" | "runs" | "limits";

const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: "automations", label: "Automations" },
  { value: "runs", label: "Runs" },
  { value: "limits", label: "Limits & safety" },
];

/** The tab bar above each of the three tabs. */
export function AutopilotTabs({ current }: { current: Tab }) {
  const navigate = useNavigate();
  const go = (tab: Tab) => {
    if (tab === current) return;
    if (tab === "automations") void navigate({ to: "/settings/$group", params: { group: "autopilot" } });
    else if (tab === "runs") {
      void navigate({ to: "/settings/autopilot/runs/$automation", params: { automation: AUTOPILOT_ALL_RUNS } });
    } else void navigate({ to: "/settings/autopilot/limits" });
  };
  return (
    <nav aria-label="Autopilot" className="flex gap-1 border-b border-border/60 px-3 sm:px-4">
      {TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          aria-current={tab.value === current ? "page" : undefined}
          className={cn(
            "-mb-px cursor-pointer border-b-2 px-2.5 pt-1 pb-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            tab.value === current
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
          onClick={() => go(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

/** A tab with a path of its own (Runs, Limits & safety): the top bar, then the tab bar over its content. */
export function AutopilotTabPage({ tab, children }: { tab: Exclude<Tab, "automations">; children: ReactNode }) {
  return (
    <>
      <SettingsTopBar group="autopilot" />
      <SettingsScroller>
        <div className="space-y-6">
          <AutopilotTabs current={tab} />
          <SettingsSubsection id={`autopilot.${tab}`}>{children}</SettingsSubsection>
        </div>
      </SettingsScroller>
    </>
  );
}

/** Route component for `/settings/autopilot/limits`. */
export function AutopilotLimitsPage() {
  return (
    <AutopilotTabPage tab="limits">
      <AutopilotLimits />
    </AutopilotTabPage>
  );
}

/** The Automations tab, the Autopilot group page's content: the status strip, Needs you, and the list. */
export function AutopilotAutomationsTab() {
  const navigate = useNavigate();
  const overview = useAutopilotOverview();
  const { message, items, pending = false, rejected = 0 } = useScopeAutomations(null);
  const customs = useCustomAutomations().data;
  const projects = useBoard().data?.projects.filter((p) => p.archivedAt === null) ?? [];
  const scopes = useAutopilotProjectScopes(projects.map((p) => p.id));
  const listed: ListedAutomation[] = items.map((item) => ({
    ...item,
    reach: automationReach(
      item.automation.key,
      item.entry,
      projects.map((p, i) => ({ title: p.title, entries: scopes[i]?.data })),
    ),
    lastRun: overview.data?.lastRuns.find((r) => r.automation === item.automation.key),
    previewRuns: overview.data?.previewRuns.find((r) => r.automation === item.automation.key)?.count ?? 0,
    custom: customOf(customs, item.automation.key),
  }));
  return (
    <div className="space-y-6">
      <AutopilotTabs current="automations" />
      <SettingsSubsection id="autopilot.automations">
        {overview.data && !message ? (
          <>
            <StatusStrip overview={overview.data} anyOn={listed.some((i) => !isOffEverywhere(i.reach))} />
            <NeedsYou needs={overview.data.needsYou} onSelect={(key) => selectAutomation(key)} />
            <section className="space-y-2.5">
              <AutomationsSplit items={listed} overview={overview.data} pending={pending} rejected={rejected} />
            </section>
          </>
        ) : (
          <SettingsGroup>
            <SettingsNote>{message ?? (overview.error ? overview.error.message : "Loading Autopilot...")}</SettingsNote>
          </SettingsGroup>
        )}
      </SettingsSubsection>
    </div>
  );

  function selectAutomation(key: string) {
    const custom = customOf(customs, key);
    if (custom) {
      void navigate({
        to: "/settings/autopilot/custom/$customId",
        params: { customId: custom.id },
        state: FROM_SETTINGS_LIST,
      });
    } else void navigate({ to: "/settings/$group", params: { group: "autopilot" }, search: { automation: key } });
  }
}

/**
 * What Autopilot is doing at a glance: running, paused or with nothing on; today's runs and spend; the limits in one
 * line; and Pause all.
 */
function StatusStrip({ overview, anyOn }: { overview: AutopilotOverview; anyOn: boolean }) {
  const setPaused = useSetAutopilotPaused();
  const openSettings = useOpenSettings();
  const { paused } = overview;
  // Under Preview everything the automations only record what they would do, so the strip mustn't say they run.
  const state = paused
    ? "Paused: no new runs start"
    : !anyOn
      ? "Nothing is on"
      : overview.engine.dryRun
        ? "Preview everything: nothing is done"
        : "Running";
  return (
    <SettingsGroup className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
      <StatusDot
        tone={paused || (anyOn && overview.engine.dryRun) ? "warning" : anyOn ? "success" : "muted"}
        label={state}
      />
      <span className="text-sm font-medium text-foreground">{state}</span>
      <span className="min-w-0 text-xs text-muted-foreground">
        {anyOn || paused
          ? `${todaySummary(overview.today)} · ${limitsSummary(overview.engine)}`
          : "Autopilot does nothing until you switch an automation on."}
      </span>
      <span className="ms-auto flex items-center gap-1">
        <Button
          id="autopilot.automations.pause-all"
          size="xs"
          variant={paused ? "outline" : "ghost-muted"}
          className={cn("scroll-mt-4", paused && "border-warning/50 bg-warning/8 text-warning-foreground")}
          disabled={setPaused.isPending}
          onClick={() => setPaused.mutate(!paused)}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? "Resume" : "Pause all"}
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={() => openSettings("autopilot.limits")}>
          Limits
        </Button>
      </span>
    </SettingsGroup>
  );
}

/** What only the user can sort out: failed runs, drafts to review and automations missing setup. Hidden when empty. */
function NeedsYou({ needs, onSelect }: { needs: AutopilotNeed[]; onSelect: (automation: string) => void }) {
  const retry = useRetryAutopilotRun();
  const dismissRun = useDismissAutopilotRun();
  const dismissDraft = useDismissAutomationDraft();
  const navigate = useNavigate();
  if (needs.length === 0) return null;
  return (
    <SettingsSection
      id="autopilot.automations.needs-you"
      title="Needs you"
      headerAction={<span className="text-xs text-muted-foreground tabular-nums">{needs.length}</span>}
    >
      {needs.map((need) => {
        switch (need.kind) {
          case "failed_run":
            return (
              <SettingsRow
                key={`run:${need.run.id}`}
                title={
                  <NeedTitle icon={<XCircleIcon className="text-destructive" />}>
                    {need.title} failed on {need.task}
                  </NeedTitle>
                }
                description={`${need.run.error ?? need.run.summary} · ${formatRelativeTimeLabel(need.run.updatedAt)}`}
                control={
                  <>
                    {canRetryRun(need.run) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(need.run.id)}
                      >
                        Retry
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={dismissRun.isPending}
                      onClick={() => dismissRun.mutate(need.run.id)}
                    >
                      Dismiss
                    </Button>
                  </>
                }
              />
            );
          case "draft":
            return (
              <SettingsRow
                key={`draft:${need.draftId}`}
                title={<NeedTitle icon={<FilePenLineIcon className="text-info" />}>Draft · {need.name}</NeedTitle>}
                description={`From ${need.createdBy} · ${formatRelativeTimeLabel(need.createdAt)}. It saves in Preview when you import it.`}
                control={
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() =>
                        void navigate({
                          to: "/settings/autopilot/custom/import",
                          search: { draft: need.draftId },
                          state: FROM_SETTINGS_LIST,
                        })
                      }
                    >
                      Review
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      disabled={dismissDraft.isPending}
                      onClick={() => dismissDraft.mutate(need.draftId)}
                    >
                      Dismiss
                    </Button>
                  </>
                }
              />
            );
          case "setup":
            return (
              <SettingsRow
                key={`setup:${need.automation}`}
                title={
                  <NeedTitle icon={<AlertTriangleIcon className="text-warning" />}>
                    {need.title} can&apos;t run as set up
                  </NeedTitle>
                }
                description={need.reason}
                control={
                  <Button size="xs" variant="outline" onClick={() => onSelect(need.automation)}>
                    Fix
                  </Button>
                }
              />
            );
        }
      })}
    </SettingsSection>
  );
}

function NeedTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-2 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}
