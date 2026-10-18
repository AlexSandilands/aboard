import { FINDING_SEVERITIES, type FindingSeverity } from "@repo/contracts";
import type { ActivityTask, BoardActivity, FinishedTask } from "../services/activity.ts";
import { OPEN_STATUSES } from "../services/activity.ts";
import { statusLabel } from "./format.ts";

/** How much of each section is shown; the rest is counted ("N more") and found with get_task. */
export const ACTIVITY_CAPS = {
  finished: 15,
  titles: 12,
  areas: 8,
  prReviews: 10,
  failures: 5,
  stalls: 10,
  notes: 8,
} as const;

const NOTE_LENGTH = 200;
const REASON_LENGTH = 160;

const ref = (t: ActivityTask) => `#${t.number}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const cut = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};
const more = (shown: number, total: number, indent: string) =>
  total > shown ? [`${indent}(${total - shown} more)`] : [];

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const stamp = (iso: string) => iso.slice(0, 16).replace("T", " ");

function finishedLine(t: FinishedTask): string {
  const spent = OPEN_STATUSES.flatMap((s) => {
    const ms = t.inStatus[s];
    return ms === undefined ? [] : [`${statusLabel(s)} ${duration(ms)}`];
  });
  const extras = [
    t.resolution ? `closed as ${t.resolution}` : null,
    spent.length ? spent.join(", ") : null,
    t.localRounds ? plural(t.localRounds, "local review round") : null,
    t.prRounds ? plural(t.prRounds, "PR review round") : null,
    t.stepsBlocked ? `${plural(t.stepsBlocked, "step")} blocked` : null,
    t.stepsSkipped ? `${plural(t.stepsSkipped, "step")} skipped` : null,
  ].filter((part) => part !== null);
  return `  ${ref(t)} ${t.title} — ${stamp(t.finishedAt)}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

/** The directory a file is in, so findings group by area rather than one line each. */
const areaOf = (file: string | null): string => {
  if (!file) return "(no file)";
  const slash = file.replace(/\\/g, "/").lastIndexOf("/");
  return slash < 0 ? "(repo root)" : file.replace(/\\/g, "/").slice(0, slash);
};

function tally<T>(items: readonly T[], key: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function findingLines(activity: BoardActivity): string[] {
  const { rounds, local, pr } = activity.reviews;
  const lines: string[] = [];
  if (rounds.total === 0 && local.length === 0 && pr.length === 0) return ["  none"];

  if (rounds.total > 0) {
    const trouble = [
      rounds.failed ? `${rounds.failed} failed` : null,
      rounds.stalled ? `${rounds.stalled} stalled` : null,
    ].filter((part) => part !== null);
    lines.push(`  Local review: ${plural(rounds.total, "round")}${trouble.length ? ` (${trouble.join(", ")})` : ""}`);
  }
  if (local.length > 0) {
    const bySeverity = FINDING_SEVERITIES.map((s) => [s, local.filter((f) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    const byStatus = (["open", "fixed", "wont_fix"] as const)
      .map((s) => [s, local.filter((f) => f.status === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s === "wont_fix" ? "won't fix" : s}`);
    lines.push(`  ${plural(local.length, "finding")}: ${bySeverity.join(", ")} (${byStatus.join(", ")})`);
    const areas = tally(local, (f) => areaOf(f.file));
    lines.push(
      `  By area: ${areas
        .slice(0, ACTIVITY_CAPS.areas)
        .map(([area, n]) => `${area} (${n})`)
        .join(", ")}${areas.length > ACTIVITY_CAPS.areas ? `, ${areas.length - ACTIVITY_CAPS.areas} more` : ""}`,
    );
    // The most severe first, so the cap drops nits and not blockers.
    const order = (s: FindingSeverity) => FINDING_SEVERITIES.indexOf(s);
    const ranked = [...local].sort((a, b) => order(a.severity) - order(b.severity));
    for (const f of ranked.slice(0, ACTIVITY_CAPS.titles)) {
      lines.push(`    ${f.severity} ${ref(f)} ${f.label}${f.file ? ` ${f.file}` : ""}: ${cut(f.title, REASON_LENGTH)}`);
    }
    lines.push(...more(ACTIVITY_CAPS.titles, local.length, "    "));
  }
  if (pr.length > 0) {
    lines.push(`  Autopilot PR reviews: ${pr.length}`);
    for (const r of pr.slice(0, ACTIVITY_CAPS.prReviews)) {
      const found = FINDING_SEVERITIES.map((s) => [s, r.counts[s]] as const)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${n} ${s}`);
      const fyi = r.fyi > 0 ? `${r.fyi} FYI` : null;
      const what = [...found, fyi].filter((part) => part !== null).join(", ") || "no issues";
      const outcome = r.handoff === "gave_up" ? "gave up" : r.handoff;
      lines.push(`    ${ref(r)} round ${r.round}/${r.maxRounds}: ${what} (${outcome})`);
    }
    lines.push(...more(ACTIVITY_CAPS.prReviews, pr.length, "    "));
  }
  return lines;
}

function runLines(activity: BoardActivity): string[] {
  if (activity.runs.length === 0) return ["  none"];
  const lines: string[] = [];
  for (const group of activity.runs) {
    const counts = [
      `${group.succeeded} succeeded`,
      group.failed ? `${group.failed} failed` : null,
      group.skipped ? `${group.skipped} skipped` : null,
      group.retries ? `${group.retries} ${group.retries === 1 ? "retry" : "retries"}` : null,
      group.gaveUp ? `${group.gaveUp} gave up` : null,
    ].filter((part) => part !== null);
    lines.push(`  ${group.title}: ${plural(group.total, "run")}: ${counts.join(", ")}`);
    for (const f of group.failures.slice(0, ACTIVITY_CAPS.failures)) {
      const task = f.task ? `${ref(f.task)} ` : "";
      lines.push(`    failed ${task}${f.restarted ? "(board restarted) " : ""}— ${cut(f.reason, REASON_LENGTH)}`);
    }
    lines.push(...more(ACTIVITY_CAPS.failures, group.failures.length, "    "));
  }
  return lines;
}

/** The text board_activity returns: one section per question, each cut to its cap. */
export function renderActivity(activity: BoardActivity): string {
  const scope = activity.project ? activity.project.title : "all projects";
  const lines = [`Board activity ${stamp(activity.from)} to ${stamp(activity.to)} UTC  ·  ${scope}`];

  lines.push("", `Tasks finished (${activity.finished.length}):`);
  if (activity.finished.length === 0) lines.push("  none");
  for (const t of activity.finished.slice(0, ACTIVITY_CAPS.finished)) lines.push(finishedLine(t));
  lines.push(...more(ACTIVITY_CAPS.finished, activity.finished.length, "  "));

  lines.push("", "Review findings:", ...findingLines(activity));
  lines.push("", "Autopilot runs:", ...runLines(activity));

  lines.push("", `Stalls (${activity.stalls.length}):`);
  if (activity.stalls.length === 0) lines.push("  none");
  for (const s of activity.stalls.slice(0, ACTIVITY_CAPS.stalls)) {
    lines.push(
      `  ${ref(s)} ${s.title} — ${stamp(s.at)} ${s.kind === "stale" ? "stale" : "waiting for input"}: ${cut(s.text, REASON_LENGTH)}`,
    );
  }
  lines.push(...more(ACTIVITY_CAPS.stalls, activity.stalls.length, "  "));

  lines.push("", `Latest note per task (${activity.notes.length}, newest first):`);
  if (activity.notes.length === 0) lines.push("  none");
  for (const n of activity.notes.slice(0, ACTIVITY_CAPS.notes)) {
    lines.push(`  ${ref(n)} ${stamp(n.at)} ${n.actor}: ${cut(n.text, NOTE_LENGTH)}`);
  }
  lines.push(...more(ACTIVITY_CAPS.notes, activity.notes.length, "  "));

  lines.push("", "Drill into a task with get_task.");
  return lines.join("\n");
}
