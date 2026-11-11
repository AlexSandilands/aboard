import type { UsageService } from "../services/usage.ts";
import { messageOf } from "./util.ts";

/**
 * Reads every linked session's tokens every 10 minutes, archived tasks included, on its own timer: the session
 * poller only runs while a browser is connected and only for live sessions. The first sweep runs shortly after
 * start, which backfills sessions linked before token tracking existed whose files are still there.
 */
export const USAGE_SWEEP_MS = 10 * 60_000;
const FIRST_SWEEP_MS = 30_000;

export function createUsageSweep(usage: () => Pick<UsageService, "sweep" | "stop">, log: Pick<Console, "warn">) {
  let timer: NodeJS.Timeout | null = null;
  let first: NodeJS.Timeout | null = null;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await usage().sweep();
    } catch (error) {
      log.warn(`[usage] sweep: ${messageOf(error)}`);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      first = setTimeout(() => void sweep(), FIRST_SWEEP_MS);
      timer = setInterval(() => void sweep(), USAGE_SWEEP_MS);
      first.unref();
      timer.unref();
    },
    stop() {
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = timer = null;
      usage().stop();
    },
  };
}
