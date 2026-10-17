import {
  AGENT_HARNESSES,
  canFork,
  type AgentSessionSnapshot,
  type AgentSessionStatus,
  type TaskLink,
} from "@repo/contracts";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";

export type SessionLink = Extract<TaskLink, { kind: "agent_session" }>;

export interface SessionStatusPresentation {
  label: string;
  colorClass: string;
  dotClass: string;
}

/** " 5m ago" for an Autopilot session that has ended; nothing when we don't know when. */
const endedAgo = (snapshot: AgentSessionSnapshot | null): string => {
  const ago = snapshot?.endedAt ? formatRelativeTimeLabel(snapshot.endedAt) : "";
  return ago ? ` ${ago}` : "";
};

/** Live status of a linked session. Unknown and not-yet-read show as "Status unknown". */
export function sessionStatusPresentation(snapshot: AgentSessionSnapshot | null): SessionStatusPresentation {
  const status: AgentSessionStatus = snapshot?.status ?? "unknown";
  switch (status) {
    case "busy":
      return {
        label: "Working",
        colorClass: "text-sky-600 dark:text-sky-300/80",
        dotClass: "bg-sky-500 dark:bg-sky-300/80",
      };
    case "idle":
      return {
        label: "Idle",
        colorClass: "text-emerald-600 dark:text-emerald-300/90",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      };
    case "running":
      return {
        label: "Running",
        colorClass: "text-emerald-600 dark:text-emerald-300/90",
        dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      };
    case "not_running":
      return { label: "Not running", colorClass: "text-muted-foreground", dotClass: "bg-muted-foreground/40" };
    case "finished":
      return {
        label: `Finished${endedAgo(snapshot)}`,
        colorClass: "text-muted-foreground",
        dotClass: "bg-emerald-500/60 dark:bg-emerald-300/60",
      };
    case "failed":
      return {
        label: `Failed${endedAgo(snapshot)}`,
        colorClass: "text-red-600 dark:text-red-300/90",
        dotClass: "bg-red-500 dark:bg-red-300/90",
      };
    case "unknown":
      return { label: "Status unknown", colorClass: "text-muted-foreground", dotClass: "bg-muted-foreground/20" };
  }
}

/** Not running now: stopped, or an Autopilot run that has ended. */
export const isSettledSession = (snapshot: AgentSessionSnapshot | null): boolean =>
  snapshot?.status === "not_running" || snapshot?.status === "finished" || snapshot?.status === "failed";

/**
 * A session Autopilot ran. Its snapshot comes from the run (finished, failed) once it ends, and while it works the
 * run names it "Autopilot · …" or "Autopilot session" (the runner's `sessionName`).
 */
export const isAutopilotSession = (link: SessionLink): boolean =>
  link.snapshot?.status === "finished" ||
  link.snapshot?.status === "failed" ||
  /^Autopilot(?: ·| session)/.test(link.label ?? "");

/** The last folder of a path, for a compact row; the full path goes in its tooltip. */
export function folderName(cwd: string): string {
  return (
    cwd
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) || cwd
  );
}

/** What the session is called: the label it was linked with, else the title its harness keeps for it. */
export function sessionName(link: SessionLink): string | null {
  return link.label?.trim() || link.snapshot?.title?.trim() || null;
}

/** The session's name, or "Claude Code session in aboard" when it has none. */
export function sessionTitle(link: SessionLink): string {
  return sessionName(link) ?? `${AGENT_HARNESSES[link.ref.harness].label} session in ${folderName(link.ref.cwd)}`;
}

export interface SessionWarning {
  title: string;
  body: string;
  /** Fork is offered (and recommended) only where the harness can fork. */
  canFork: boolean;
  /** Offer to open the task's T3 thread: the session runs inside an app and the task has a thread. */
  offerThread: boolean;
}

/** What the "already running" dialog says for a session the server refused to reopen. */
export function sessionWarning(
  link: SessionLink,
  snapshot: AgentSessionSnapshot | null,
  opts: { hasThread: boolean },
): SessionWarning {
  const harness = AGENT_HARNESSES[link.ref.harness].label;
  const fork = canFork(link.ref.harness);
  const where = snapshot?.inApp ? "inside T3 Code" : "in another window";
  const busy = snapshot?.status === "busy" ? " and working right now" : "";
  const body = [
    `This ${harness} session is still running ${where}${busy}. Opening it again runs it twice on one history, and the two can overwrite each other.`,
    fork ? "Fork it to continue from here in a new session instead." : null,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    title: "Session already running",
    body,
    canFork: fork,
    offerThread: Boolean(snapshot?.inApp) && opts.hasThread,
  };
}
