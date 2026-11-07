// How an automation is doing, on its detail and in Needs you: its week, the tuning hints read from it, and the
// projects it paused itself in (docs/features/autopilot.md#health-and-hints).
import { type AutopilotAutoPause, type AutopilotHint } from "@repo/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, InfoIcon, PauseCircleIcon, XCircleIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DetailSection } from "~/components/settings/agents/SplitCard";
import { SettingsNote, SettingsRow } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { formatElapsedDurationLabel, formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import { useAutomationWeek, useDismissHint, useResumeAutoPause } from "~/state/autopilotRunHistory";
import { useUpdateTask } from "~/state/mutations";
import { copyFixPrompt } from "./askAgent";
import type { ConfigUpdate } from "./AutomationRows";
import { formatCost, runStatusLabel, runStatusVariant, withConfigValue } from "./autopilot.logic";
import { dayLabel, spendText, weekBars } from "./health.logic";
import { RunHistoryLink } from "./RunHistoryLink";

/** This week: runs, failures and spend, a bar a day, and the latest runs. */
export function WeekSection({ automation }: { automation: string }) {
  const week = useAutomationWeek(automation);
  const data = week.data;
  return (
    <DetailSection title="This week">
      {!data ? (
        <SettingsNote>
          {week.error ? week.error.message : <Spinner className="size-3.5" aria-label="Loading the week" />}
        </SettingsNote>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3 px-3 py-3 sm:px-4">
            <Kpi value={String(data.runs)} label={data.runs === 1 ? "run" : "runs"} />
            <Kpi value={String(data.failed)} label="failed" tone={data.failed > 0 ? "danger" : undefined} />
            <Kpi value={spendText(data.spendUsd)} label="spent" />
            {data.deferred > 0 ? <Kpi value={String(data.deferred)} label="deferred" /> : null}
            {data.wouldRun > 0 ? <Kpi value={String(data.wouldRun)} label="would have run" /> : null}
            {data.gaveUp.review + data.gaveUp.comments > 0 ? (
              <Kpi value={String(data.gaveUp.review + data.gaveUp.comments)} label="gave up" tone="warning" />
            ) : null}
            <div className="ms-auto flex h-10 items-end gap-1" role="img" aria-label="Runs per day">
              {weekBars(data.days).map((bar) => (
                <span
                  key={bar.date}
                  title={`${dayLabel(bar.date)}: ${bar.runs} run${bar.runs === 1 ? "" : "s"}${bar.failed ? `, ${bar.failed} failed` : ""}`}
                  className="relative flex w-2.5 flex-col justify-end overflow-hidden rounded-sm bg-muted"
                  style={{ height: "100%" }}
                >
                  <span
                    className="w-full bg-primary/60"
                    style={{ height: `${(bar.height - bar.failedHeight) * 100}%` }}
                  />
                  <span className="w-full bg-destructive/80" style={{ height: `${bar.failedHeight * 100}%` }} />
                </span>
              ))}
            </div>
          </div>
          {data.lastRuns.length === 0 ? (
            <SettingsNote>No runs yet.</SettingsNote>
          ) : (
            <ul className="flex flex-col divide-y divide-border/50 border-t border-border/50">
              {data.lastRuns.map((run) => {
                const cost = formatCost(run.costUsd);
                const at = run.finishedAt ?? run.createdAt;
                return (
                  <li key={run.id} className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs sm:px-4">
                    <Badge variant={runStatusVariant(run.status, run.deferred)} size="sm">
                      {runStatusLabel(run)}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={run.error ?? run.summary}>
                      {run.error ?? run.summary}
                    </span>
                    {cost ? <span className="shrink-0 tabular-nums text-muted-foreground">{cost}</span> : null}
                    <span className="shrink-0 tabular-nums text-secondary-label" title={new Date(at).toLocaleString()}>
                      {formatElapsedDurationLabel(at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex justify-end border-t border-border/50 px-3 py-2 sm:px-4">
            <RunHistoryLink automation={automation} label="All runs" size="xs" />
          </div>
        </>
      )}
    </DetailSection>
  );
}

function Kpi({ value, label, tone }: { value: string; label: string; tone?: "danger" | "warning" }) {
  return (
    <div className="flex flex-col">
      <span
        className={cn(
          "text-lg font-medium tabular-nums text-foreground",
          tone === "danger" && "text-destructive-foreground",
          tone === "warning" && "text-warning-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-2xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** What a hint's board-config action needs: how to save the automation's board config. */
export interface HintTarget {
  onConfig: ConfigUpdate;
}

/** Carries out a hint's one click. */
export function useApplyHint() {
  const updateTask = useUpdateTask();
  const navigate = useNavigate();
  const dismiss = useDismissHint();
  /** Applied: the hint has done its job, and comes back only if its situation does. */
  const applied = (hint: AutopilotHint) => {
    if (hint.done) toastManager.add({ type: "success", title: hint.done });
    dismiss.mutate(hint.id);
  };
  const apply = async (hint: AutopilotHint, target: HintTarget | undefined) => {
    const { action } = hint;
    switch (action.kind) {
      case "board_config":
        if (!target) return;
        target.onConfig((current) => withConfigValue(current, action.key, action.value));
        applied(hint);
        return;
      case "flag_tasks":
        await Promise.all(action.taskIds.map((id) => updateTask.mutateAsync({ id, autopilot: true })));
        if (hint.done) toastManager.add({ type: "success", title: hint.done });
        return;
      case "ask_agent":
        await copyFixPrompt(action.prompt, hint.done);
        // Handed over: until the next failure.
        dismiss.mutate(hint.id);
        return;
      case "open_limits":
        void navigate({ to: "/settings/autopilot/limits" });
        return;
    }
  };
  return { apply, pending: updateTask.isPending, dismiss };
}

export const HINT_ICONS: Record<AutopilotHint["tone"], ReactNode> = {
  info: <InfoIcon className="text-info" />,
  warning: <AlertTriangleIcon className="text-warning" />,
  danger: <XCircleIcon className="text-destructive" />,
};

/** A hint with its one click and Dismiss, on an automation's detail. */
export function HintNotice({ hint, target }: { hint: AutopilotHint; target?: HintTarget }) {
  const { apply, pending, dismiss } = useApplyHint();
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-x-2.5 gap-y-2 rounded-lg border px-3 py-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
        hint.tone === "danger"
          ? "border-destructive/30 bg-destructive/6"
          : hint.tone === "warning"
            ? "border-warning/30 bg-warning/6"
            : "border-info/30 bg-info/6",
      )}
    >
      {HINT_ICONS[hint.tone]}
      <span className="min-w-0 flex-1 basis-48 text-foreground">{hint.text}</span>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="xs" variant="outline" disabled={pending} onClick={() => void apply(hint, target)}>
          {hint.action.label}
        </Button>
        <Button size="xs" variant="ghost-muted" disabled={dismiss.isPending} onClick={() => dismiss.mutate(hint.id)}>
          Dismiss
        </Button>
      </span>
    </div>
  );
}

/** The projects an automation paused itself in after failing there, each with why and Resume. */
export function PausedRows({ pauses }: { pauses: readonly AutopilotAutoPause[] }) {
  const resume = useResumeAutoPause();
  return pauses.map((pause) => (
    <SettingsRow
      key={pause.projectId}
      title={
        <span className="flex items-center gap-2">
          <PauseCircleIcon aria-hidden className="size-4 shrink-0 text-warning" />
          Paused in {pause.projectTitle}
        </span>
      }
      description={`${pause.reason} · ${formatRelativeTimeLabel(pause.pausedAt)}`}
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={resume.isPending}
          onClick={() => resume.mutate({ automation: pause.automation, projectId: pause.projectId })}
        >
          Resume
        </Button>
      }
    />
  ));
}
