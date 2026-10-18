import { inQuietHours, type AutopilotEngineSettings } from "@repo/contracts";
import type { Services } from "../services/types.ts";

/** Why an agent run can't start, as the engine holds candidates back. */
export type AgentHold = "quiet hours" | "concurrency" | "daily run cap" | "daily spend cap";

/** Local midnight of `now`, for the daily caps. */
export const startOfDay = (now: Date): string =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

const usageAt = (s: Services, at: Date) => {
  const agents = s.autopilot
    .automations()
    .filter((a) => a.needsAgent)
    .map((a) => a.key);
  return s.autopilot.usage(agents, startOfDay(at));
};

type Usage = ReturnType<typeof usageAt>;

const capHold = (engine: AutopilotEngineSettings, usage: Usage): "daily run cap" | "daily spend cap" | null => {
  if (engine.dailyRunCap !== null && usage.started >= engine.dailyRunCap) return "daily run cap";
  if (engine.dailySpendCapUsd !== null && usage.spendUsd >= engine.dailySpendCapUsd) return "daily spend cap";
  return null;
};

/** Why an agent run can't start at `at`, or null when it can. */
export function agentHold(s: Services, engine: AutopilotEngineSettings, at: Date): AgentHold | null {
  if (inQuietHours(engine.quietHours, at.getHours() * 60 + at.getMinutes())) return "quiet hours";
  const usage = usageAt(s, at);
  if (usage.active >= engine.maxConcurrent) return "concurrency";
  return capHold(engine, usage);
}

/**
 * The daily cap reached on `at`'s day, or null. Apart from agentHold, so a full concurrency slot doesn't hide it: a
 * request made then would otherwise wait for a slot and start once the cap resets at midnight.
 */
export function dailyCapHold(
  s: Services,
  engine: AutopilotEngineSettings,
  at: Date,
): "daily run cap" | "daily spend cap" | null {
  return capHold(engine, usageAt(s, at));
}
