import {
  AUTOPILOT_ORCHESTRATE,
  inQuietHours,
  nextMinutesSlot,
  orchestrateNeedsLooking,
  type AutopilotEngineSettings,
  type AutopilotScopeEntry,
  type OrchestrateState,
  type TaskSummary,
} from "@repo/contracts";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { runStatusLabel } from "./autopilot.logic";

// ── Orchestrate's section of the lane popover, and the pill's timer ───────

/** "12:34", or "1:02:03" from an hour up. Never negative: a slot that has come reads 0:00 until the pass runs. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The pill's short form: "12m", "<1m", "2h", "1h 5m". Minutes round up, so it never reads 0m before the slot. */
export function formatPillCountdown(ms: number): string {
  if (ms < 60_000) return "<1m";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * What Orchestrate's section says about the next check, given the server's state and the clock. The slot is counted
 * here from `everyMinutes`, so the countdown rolls on to the next slot without waiting for the server.
 */
export type OrchestrateLine =
  | { kind: "running"; text: string }
  | { kind: "requested"; text: string }
  | { kind: "held"; text: string }
  | { kind: "countdown"; text: string; nextAt: Date };

export function orchestrateLine(
  state: Pick<OrchestrateState, "enabled" | "everyMinutes" | "hold" | "running" | "requestedAt">,
  engine: Pick<AutopilotEngineSettings, "quietHours"> | undefined,
  now: Date,
): OrchestrateLine {
  if (state.running) return { kind: "running", text: "Running…" };
  // A request waits out Pause all like any run, so the pause is what to say.
  if (state.requestedAt && state.hold !== "paused")
    return { kind: "requested", text: "Run requested: it starts when a run slot is free" };
  switch (state.hold) {
    case "off":
      return { kind: "held", text: "Off in this project" };
    case "paused":
      return { kind: "held", text: "Paused: no checks until Autopilot resumes" };
    case "quiet_hours":
      return {
        kind: "held",
        text: engine ? `Quiet hours: no checks until ${engine.quietHours.end}` : "Quiet hours: no checks for now",
      };
    case "daily_cap":
      return { kind: "held", text: "Today's cap is reached: no checks until tomorrow" };
    case "idle":
      return { kind: "held", text: "Idle: nothing to check" };
    case null: {
      const nextAt = nextMinutesSlot(state.everyMinutes, now);
      return { kind: "countdown", text: `Next check in ${formatCountdown(nextAt.getTime() - now.getTime())}`, nextAt };
    }
  }
}

/** "Last ran 17m ago · Done", "Started just now", or "No runs yet". */
export function lastRunText(lastRun: OrchestrateState["lastRun"]): string {
  if (!lastRun) return "No runs yet";
  if (lastRun.status === "queued" || lastRun.status === "running") {
    return `Started ${formatRelativeTimeLabel(lastRun.startedAt ?? lastRun.createdAt)}`;
  }
  return `Last ran ${formatRelativeTimeLabel(lastRun.finishedAt ?? lastRun.createdAt)} · ${runStatusLabel(lastRun)}`;
}

/** Whether a project has a task Orchestrate would look at; without one its slots don't run. */
export const projectHasOrchestrateWork = (
  tasks: ReadonlyArray<Pick<TaskSummary, "projectId" | "archivedAt" | "status" | "attention" | "autoMerge">>,
  projectId: string,
): boolean => tasks.some((t) => t.projectId === projectId && orchestrateNeedsLooking(t));

/**
 * When the lane pill counts down to Orchestrate's next check in the project, or null for no timer: Orchestrate off
 * there, Pause all, a run going (the pill sweeps instead), quiet hours at the slot, or nothing to look at. Worked out
 * from what the board already has, so every lane needn't ask the server; the daily caps are left to the popover.
 */
export function pillTimerAt(input: {
  entries: ReadonlyArray<AutopilotScopeEntry> | undefined;
  paused: boolean | undefined;
  running: boolean;
  engine: Pick<AutopilotEngineSettings, "quietHours"> | undefined;
  /** The project has a task Orchestrate would look at (projectHasOrchestrateWork). */
  hasWork: boolean;
  now: Date;
}): Date | null {
  const entry = input.entries?.find((e) => e.automation === AUTOPILOT_ORCHESTRATE);
  if (!entry?.enabled || input.paused || input.running || !input.hasWork) return null;
  const every = entry.effectiveConfig.everyMinutes;
  const next = nextMinutesSlot(typeof every === "number" && every > 0 ? every : 30, input.now);
  if (input.engine && inQuietHours(input.engine.quietHours, next.getHours() * 60 + next.getMinutes())) return null;
  return next;
}
