const DAY_MS = 24 * 60 * 60 * 1000;

/** The retention choices offered; a stored value that isn't one is added so the picker can show it. */
export function retentionOptions(current: number): Array<{ value: string; label: string }> {
  const days = [1, 7, 14, 30, 60, 90, 180, 365];
  return [...new Set([...days, current])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: dayCount(n) }));
}

export const dayCount = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;

/** "12 days left", "less than a day left": until the purge removes a trashed task for good. */
export function timeLeft(purgeAt: string, now: number): string {
  const left = Date.parse(purgeAt) - now;
  // Rounded, so a task deleted just now reads as the whole retention period rather than a day short.
  return left < DAY_MS ? "less than a day left" : `${dayCount(Math.round(left / DAY_MS))} left`;
}
