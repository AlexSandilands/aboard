import type { TaskLink } from "./schemas.ts";

/**
 * How an agent session is doing, whatever runs it: working, waiting on the user, failed, fine (finished or idle), or
 * unknown when the board can't tell.
 */
export type SessionHealthState = "working" | "waiting" | "failed" | "ok" | "unknown";

export interface SessionHealth {
  state: SessionHealthState;
  /** What the board calls this provider's sessions in a flag: "Thread failed", "Session failed". */
  noun: string;
  /** What a waiting session waits for, when the provider says. */
  waitingFor?: "input" | "approval";
  /** When the session last did something, if known: with the status, it tells one failure from the next. */
  activityAt: string | null;
  /**
   * A session Autopilot ran. Its failure is the run's, which the `autopilot` flag already reports, so it raises no
   * session flag of its own.
   */
  autopilotRun: boolean;
  /** The provider's own status word, for fingerprints. */
  status: string;
}

type SessionLink = Extract<TaskLink, { kind: "t3_thread" | "agent_session" }>;

/**
 * One reader per link kind that is an agent session. A new provider (another link kind, or another harness whose
 * statuses differ) is added here and nowhere else: attention, its labels and its dismissal follow from the result.
 */
const READERS: { [K in SessionLink["kind"]]: (link: Extract<TaskLink, { kind: K }>) => SessionHealth | null } = {
  t3_thread: ({ snapshot }) => {
    if (!snapshot) return null;
    const { status } = snapshot;
    const state: SessionHealthState =
      status === "failed"
        ? "failed"
        : status === "input" || status === "approval"
          ? "waiting"
          : status === "working" || status === "waiting"
            ? "working"
            : "ok";
    return {
      state,
      noun: "Thread",
      ...(status === "input" || status === "approval" ? { waitingFor: status } : {}),
      activityAt: snapshot.lastActivityAt ?? null,
      autopilotRun: false,
      status,
    };
  },
  agent_session: ({ snapshot }) => {
    if (!snapshot) return null;
    const { status } = snapshot;
    const state: SessionHealthState =
      status === "failed"
        ? "failed"
        : status === "busy" || status === "running"
          ? "working"
          : status === "unknown"
            ? "unknown"
            : "ok";
    return {
      state,
      noun: "Session",
      activityAt: snapshot.endedAt ?? null,
      // finished and failed only ever come from an Autopilot run (see AgentSessionStatus).
      autopilotRun: status === "finished" || status === "failed",
      status,
    };
  },
};

/** The health of the agent session behind a link; null for a link that isn't a session, or one not read yet. */
export function sessionHealth(link: TaskLink): SessionHealth | null {
  if (link.kind === "t3_thread") return READERS.t3_thread(link);
  if (link.kind === "agent_session") return READERS.agent_session(link);
  return null;
}
