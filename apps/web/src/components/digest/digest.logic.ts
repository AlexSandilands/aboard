import type { Digest, DigestMode, TaskSummary } from "@repo/contracts";
import { formatCost } from "~/components/autopilot/autopilot.logic";

// en-US for its short names ("Sep", not en-GB's "Sept"); the hours are 24-hour and the zone is the browser's.
const INSTANT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Fri 17 Oct 09:00" in local time; empty for something that isn't a date. */
export function formatDigestInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const part = Object.fromEntries(INSTANT.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part.weekday} ${part.day} ${part.month} ${part.hour}:${part.minute}`;
}

/** The period a digest covers: "Fri 17 Oct 09:00 to Sat 18 Oct 09:00". */
export function formatDigestPeriod(digest: Pick<Digest, "from" | "to">): string {
  return `${formatDigestInstant(digest.from)} to ${formatDigestInstant(digest.to)}`;
}

const MODE_LABEL: Record<DigestMode, string> = { plain: "Plain", summarised: "Summarised" };

export const digestModeLabel = (mode: DigestMode): string => MODE_LABEL[mode];

/** How it was made, for the muted line under the title: "Made on a schedule", "Made on request", then the cost. */
export function digestFacts(digest: Pick<Digest, "trigger" | "costUsd">): string[] {
  const facts = [digest.trigger === "schedule" ? "Made on a schedule" : "Made on request"];
  const cost = formatCost(digest.costUsd);
  if (cost) facts.push(cost);
  return facts;
}

/** What a screen reader hears for the header button, whose dot and spinner are only visual. */
export function digestButtonText(unread: number, writing: boolean): string {
  const state = [writing ? "being written" : null, unread > 0 ? `${unread} unread` : null].filter(Boolean);
  return state.length ? `Digest of what changed, ${state.join(", ")}` : "Digest of what changed";
}

/** The digest being looked at: the picked one, or the newest when none is picked or the pick has aged out. */
export function pickDigest(items: ReadonlyArray<Digest>, selectedId: string | null): Digest | undefined {
  return items.find((d) => d.id === selectedId) ?? items[0];
}

/** The id of the next newer or older digest than `current`, or null at the end of the list. */
export function neighbourDigest(
  items: ReadonlyArray<Digest>,
  current: string | undefined,
  direction: "newer" | "older",
): string | null {
  const index = items.findIndex((d) => d.id === current);
  if (index < 0) return null;
  return items[index + (direction === "older" ? 1 : -1)]?.id ?? null;
}

/** A row of the digest picker: when the period ended, and whether it hasn't been opened. */
export function digestOptionLabel(digest: Pick<Digest, "to" | "readAt">): string {
  return `${formatDigestInstant(digest.to)}${digest.readAt ? "" : " · unread"}`;
}

/** Task number to id, for linking "#42" in a digest. The board snapshot leaves archived tasks out, so those stay text. */
export function taskIdsByNumber(tasks: ReadonlyArray<Pick<TaskSummary, "id" | "number">>): Map<number, string> {
  return new Map(tasks.map((t) => [t.number, t.id]));
}
