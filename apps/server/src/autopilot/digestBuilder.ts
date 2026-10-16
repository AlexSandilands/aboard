import { STATUS_LABELS, type NotificationKind, type TaskStatus } from "@repo/contracts";

// The plain digest (docs/features/autopilot.md#digest-of-what-changed): what changed on the board over a period, as
// Markdown, built by code with no LLM. Pure: `services/digests.ts` gathers the data, this renders it.

interface TaskRef {
  number: number;
  title: string;
}

export interface DigestMove extends TaskRef {
  from: TaskStatus;
  to: TaskStatus;
}

export interface DigestMerge extends TaskRef {
  /** `owner/repo#12`. */
  pr: string;
}

/** A task that started needing the user: an agent waiting, failing checks, changes requested. */
export interface DigestAttention extends TaskRef {
  kind: NotificationKind;
}

/** An Autopilot run that failed or ended asking for the user. */
export interface DigestRunProblem {
  /** The task it worked on, when it had one. */
  number: number | null;
  automation: string;
  failed: boolean;
  message: string;
}

export interface DigestRuns {
  total: number;
  succeeded: number;
  failed: number;
  problems: DigestRunProblem[];
}

export interface DigestProjectData {
  title: string;
  moves: DigestMove[];
  merged: DigestMerge[];
  attention: DigestAttention[];
  runs: DigestRuns;
}

export interface DigestData {
  from: Date;
  to: Date;
  /** Only projects the digest covers; the ones with nothing to report are left out when rendering. */
  projects: DigestProjectData[];
  /** What Autopilot's real runs in the period cost, across the board. */
  costUsd: number;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Fri 17 Oct 09:00", in the server's local time. */
export const digestTime = (date: Date): string =>
  `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Keeps a title or message from being read as Markdown. */
const escapeMd = (text: string): string => text.replace(/[\\`*_[\]<>]/g, "\\$&");

/** One line, cut short: an error can be a stack trace. */
const oneLine = (text: string, max = 160): string => {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const ATTENTION_TEXT: Partial<Record<NotificationKind, string>> = {
  thread_waiting: "an agent is waiting for you",
  pr_checks_failing: "checks are failing",
  pr_changes_requested: "changes were requested",
};

const task = (t: TaskRef) => `#${t.number} ${escapeMd(t.title)}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const isEmpty = (p: DigestProjectData) =>
  p.moves.length === 0 && p.merged.length === 0 && p.attention.length === 0 && p.runs.total === 0;

/** Whether anything at all happened in the period, for skipping the agent on a quiet one. */
export const digestIsEmpty = (data: DigestData): boolean => data.projects.every(isEmpty);

/** The one-line count for a notification: "3 moved · 1 PR merged · 2 need attention · 1 failed run". */
export function digestHeadline(data: DigestData): string {
  const sum = (pick: (p: DigestProjectData) => number) => data.projects.reduce((n, p) => n + pick(p), 0);
  const moved = sum((p) => p.moves.length);
  const merged = sum((p) => p.merged.length);
  const attention = sum((p) => p.attention.length);
  const failed = sum((p) => p.runs.problems.length);
  const parts = [
    moved > 0 ? `${moved} moved` : null,
    merged > 0 ? `${plural(merged, "PR")} merged` : null,
    attention > 0 ? `${attention} ${attention === 1 ? "needs" : "need"} attention` : null,
    failed > 0 ? plural(failed, "run problem") : null,
  ].filter((p) => p !== null);
  return parts.length > 0 ? parts.join(" · ") : "Nothing changed";
}

/** The digest as Markdown, a section per project with something to report. */
export function renderPlainDigest(data: DigestData): string {
  const lines = [`# Digest: ${digestTime(data.to)}`, "", `Since ${digestTime(data.from)}.`];
  const reported = data.projects.filter((p) => !isEmpty(p));
  if (reported.length === 0) lines.push("", "Nothing changed.");
  for (const project of reported) {
    lines.push("", `## ${escapeMd(project.title)}`);
    if (project.moves.length > 0) {
      lines.push("", "**Moved**");
      for (const m of project.moves) lines.push(`- ${task(m)}: ${STATUS_LABELS[m.from]} → ${STATUS_LABELS[m.to]}`);
    }
    if (project.merged.length > 0) {
      lines.push("", "**Merged pull requests**");
      for (const m of project.merged) lines.push(`- ${task(m)}: ${escapeMd(m.pr)}`);
    }
    if (project.attention.length > 0) {
      lines.push("", "**Needs attention**");
      for (const a of project.attention) lines.push(`- ${task(a)}: ${ATTENTION_TEXT[a.kind] ?? "needs you"}`);
    }
    if (project.runs.total > 0) {
      const { total, succeeded, failed, problems } = project.runs;
      lines.push("", "**Autopilot**");
      lines.push(
        `- ${plural(total, "run")}: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ""}${
          total - succeeded - failed > 0 ? `, ${total - succeeded - failed} skipped` : ""
        }`,
      );
      for (const p of problems) {
        const where = p.number === null ? "" : `#${p.number} `;
        lines.push(
          `- ${where}${escapeMd(p.automation)} ${p.failed ? "failed" : "needs you"}: ${escapeMd(oneLine(p.message))}`,
        );
      }
    }
  }
  if (data.costUsd > 0) lines.push("", `Autopilot spent $${data.costUsd.toFixed(2)} in this period.`);
  return `${lines.join("\n")}\n`;
}
