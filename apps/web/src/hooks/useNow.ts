import { useEffect, useState } from "react";

/**
 * The clock, re-read every `intervalMs` while `enabled`, for countdowns. Switched on, it reads the clock straight
 * away (in a zero-delay timeout, not during the effect), so a value kept from while it was off is never shown.
 */
export function useNow(intervalMs: number, enabled = true): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [intervalMs, enabled]);
  return now;
}
