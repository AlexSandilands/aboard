// Settings → Autopilot: three tabs. Automations (what is happening, what needs you, and every automation in a split
// card), Runs (the run history) and Limits & safety (the engine's settings and the variables). Runs and Limits have
// paths of their own; the tab bar ties them together.
import {
  AUTOPILOT_ALL_RUNS,
  automationTitleOf,
  canRetryRun,
  limitsSummary,
  todaySummary,
  type AutopilotOverview,
} from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  FilePenLineIcon,
  GitPullRequestIcon,
  PauseCircleIcon,
  PauseIcon,
  PlayIcon,
  XCircleIcon,
} from "lucide-react";
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
import { useResumeAutoPause } from "~/state/autopilotRunHistory";
import { useCustomAutomations, useDismissAutomationDraft } from "~/state/customAutomations";
import { useDismissAutopilotRun, useRetryAutopilotRun, useSetAutopilotPaused } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotProjectScopes, useBoard } from "~/state/queries";
import { useBoardAutomations } from "./AutomationRows";
import { automationReach, isOffEverywhere } from "./automationList.logic";
import { AutopilotLimits } from "./AutopilotSettingsSection";
import { AskToFix } from "./AskAgentButtons";
import { QuickSetup, type QuickSetupState } from "./QuickSetup";
import { AutomationsSplit, customOf, type ListedAutomation } from "./AutomationsSplit";
import { HINT_ICONS, useApplyHint, type HintTarget } from "./HealthSections";
import { pausedForRun } from "./health.logic";

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
  const { message, items, pending = false, rejected = 0 } = useBoardAutomations();
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
  const quickSetup: QuickSetupState = {
    automations: overview.data?.automations ?? [],
    board: items.map((item) => item.entry),
    projects: projects.map((p, i) => ({ title: p.title, entries: scopes[i]?.data ?? [] })),
  };
  // Not known until every project's scope has loaded: before that a project's own switch would be missed.
  const nothingOn = scopes.every((s) => s.data) && !listed.some((i) => !isOffEverywhere(i.reach));
  return (
    <div className="space-y-6">
      <AutopilotTabs current="automations" />
      <SettingsSubsection id="autopilot.automations">
        {overview.data && !message ? (
          <>
            <StatusStrip overview={overview.data} anyOn={listed.some((i) => !isOffEverywhere(i.reach))} />
            {nothingOn ? (
              // The empty state: nothing is on, so the first thing to offer is switching a sensible set on.
              <SettingsGroup className="px-3 py-3 sm:px-4">
                <QuickSetup state={quickSetup} title="Start with Quick setup" />
              </SettingsGroup>
            ) : null}
            <NeedsYou
              overview={overview.data}
              onSelect={(key) => selectAutomation(key)}
              targetFor={(key) => {
                const item = listed.find((i) => i.automation.key === key);
                return item ? { onConfig: item.onConfig } : undefined;
              }}
            />
            <section className="space-y-2.5">
              <AutomationsSplit items={listed} pending={pending} rejected={rejected} quickSetup={quickSetup} />
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

/**
 * What only the user can sort out: failed runs, automations that paused themselves in a project, drafts to review,
 * automations missing setup, and tuning hints. Hidden when empty.
 */
function NeedsYou({
  overview,
  onSelect,
  targetFor,
}: {
  overview: AutopilotOverview;
  onSelect: (automation: string) => void;
  targetFor: (automation: string) => HintTarget | undefined;
}) {
  const retry = useRetryAutopilotRun();
  const dismissRun = useDismissAutopilotRun();
  const dismissDraft = useDismissAutomationDraft();
  const resume = useResumeAutoPause();
  const hint = useApplyHint();
  const navigate = useNavigate();
  const { needsYou: needs, autoPaused, hints } = overview;
  const titleOf = (key: string) => automationTitleOf(overview.automations, key);
  const count = needs.length + autoPaused.length + hints.length;
  if (count === 0) return null;
  return (
    <SettingsSection
      id="autopilot.automations.needs-you"
      title="Needs you"
      headerAction={<span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
    >
      {autoPaused.map((pause) => (
        <SettingsRow
          key={`paused:${pause.automation}:${pause.projectId}`}
          title={
            <NeedTitle icon={<PauseCircleIcon className="text-warning" />}>
              {titleOf(pause.automation)} paused itself in {pause.projectTitle}
            </NeedTitle>
          }
          description={`${pause.reason} · ${formatRelativeTimeLabel(pause.pausedAt)}`}
          control={
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={resume.isPending}
                onClick={() => resume.mutate({ automation: pause.automation, projectId: pause.projectId })}
              >
                Resume
              </Button>
              <Button size="xs" variant="ghost-muted" onClick={() => onSelect(pause.automation)}>
                Open
              </Button>
            </>
          }
        />
      ))}
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
                    {canRetryRun(need.run) && !pausedForRun(autoPaused, need.run) ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(need.run.id)}
                      >
                        Retry
                      </Button>
                    ) : null}
                    <AskToFix run={need.run} automationTitle={need.title} task={need.task} />
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
                title={
                  <NeedTitle icon={<FilePenLineIcon className="text-info" />}>
                    {need.replaces ? `Change to ${need.replaces.name}` : `Draft · ${need.name}`}
                  </NeedTitle>
                }
                description={
                  need.replaces
                    ? `From ${need.createdBy} · ${formatRelativeTimeLabel(need.createdAt)}. Review the difference before it applies.`
                    : `From ${need.createdBy} · ${formatRelativeTimeLabel(need.createdAt)}. It saves in Preview when you import it.`
                }
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
          case "pr_approval":
            return (
              <SettingsRow
                key={`pr:${need.url}`}
                title={
                  <NeedTitle icon={<GitPullRequestIcon className="text-info" />}>
                    Ready for your approval · {need.pr} {need.title}
                  </NeedTitle>
                }
                description={`${need.author ? `By ${need.author} · ` : ""}${need.reason} · ${formatRelativeTimeLabel(need.since)}`}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    render={
                      <a href={need.url} target="_blank" rel="noreferrer" aria-label={`Open ${need.pr} on GitHub`} />
                    }
                  >
                    Open PR
                  </Button>
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
      {hints.map((h) => (
        <SettingsRow
          key={`hint:${h.id}`}
          title={
            <NeedTitle icon={HINT_ICONS[h.tone]}>
              {h.automation ? `${titleOf(h.automation)}: ` : ""}
              {h.text}
            </NeedTitle>
          }
          control={
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={hint.pending}
                onClick={() => void hint.apply(h, h.automation ? targetFor(h.automation) : undefined)}
              >
                {h.action.label}
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={hint.dismiss.isPending}
                onClick={() => hint.dismiss.mutate(h.id)}
              >
                Dismiss
              </Button>
            </>
          }
        />
      ))}
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
