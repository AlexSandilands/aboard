import { taskNumberValue, taskLabel } from "@repo/contracts";
import type { AgentSessionRef, TaskLink } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { Services } from "../services/types.ts";
import {
  condenseTranscriptFile,
  pageEntries,
  redact,
  type TranscriptPage,
  type TranscriptStats,
} from "./claudeTranscript.ts";
import { transcriptPath } from "./claudeSessionTitle.ts";

export interface SessionTranscript {
  taskNumber: number | string;
  sessionId: string;
  label: string | null;
  /** The other linked sessions, described, when none was asked for and the newest was read. */
  otherSessions?: string[];
  stats: TranscriptStats;
  page: TranscriptPage;
}

/** One page of a session's transcript, read where its files are. */
export type TranscriptRead = Pick<SessionTranscript, "stats" | "page">;

export interface SessionTranscriptReader {
  /** A page of the transcript of a session on this machine, found by its id and folder; for a board that asks. */
  readSession(ref: Pick<AgentSessionRef, "sessionId" | "cwd">, offset: number): Promise<TranscriptRead>;
  /** The condensed transcript of one Claude Code session linked to the task, a page at a time. */
  read(
    taskId: string,
    input: { session?: string | undefined; offset?: number | undefined },
  ): Promise<SessionTranscript>;
}

type SessionLink = Extract<TaskLink, { kind: "agent_session" }>;

/** A session for an error message, redacted: its label and title are free text. */
const describe = (link: SessionLink) =>
  redact(
    `${link.ref.sessionId}${link.label ? ` "${link.label}"` : ""}${link.snapshot ? ` (${link.snapshot.status.replace("_", " ")})` : ""}`,
  );

/**
 * Only sessions linked to the task are read, by the id the link holds, never by a path an agent gives: the transcript
 * is found under the Claude Code folder the way session titles are.
 */
export function createSessionTranscriptReader(deps: {
  services: () => Services;
  claudeDir: string;
  /**
   * Reads a session that ran on a connected machine, there: its files aren't on this one. Null when the machine is
   * this one (a runner reading its own).
   */
  onMachine?: (ref: AgentSessionRef, offset: number) => Promise<TranscriptRead> | null;
}): SessionTranscriptReader {
  const readSession: SessionTranscriptReader["readSession"] = async (ref, offset) => {
    const path = transcriptPath(deps.claudeDir, ref.sessionId, ref.cwd);
    if (!path) {
      throw new AppError(
        "NOT_FOUND",
        `No transcript for session ${ref.sessionId} was found on this machine (it may have run elsewhere, or been cleaned up).`,
      );
    }
    // Each page reads and condenses the whole file again. No cache: a transcript is read a handful of times while an
    // agent audits it, condensing streams the file, and a live session's transcript changes between pages anyway.
    try {
      const condensed = await condenseTranscriptFile(path);
      return { stats: condensed.stats, page: pageEntries(condensed.entries, offset) };
    } catch {
      throw new AppError("NOT_FOUND", `The transcript of session ${ref.sessionId} couldn't be read.`);
    }
  };
  return {
    readSession,
    async read(taskId, { session, offset }) {
      const task = deps.services().tasks.summary(taskId);
      const sessions = task.links.filter(
        (l): l is SessionLink => l.kind === "agent_session" && l.ref.harness === "claude-code",
      );
      if (sessions.length === 0) {
        const others = [
          ...(task.links.some((l) => l.kind === "t3_thread") ? ["T3 Code threads"] : []),
          ...(task.links.some((l) => l.kind === "agent_session" && l.ref.harness === "copilot-cli")
            ? ["Copilot CLI sessions"]
            : []),
        ];
        throw new AppError(
          "NOT_FOUND",
          `${taskLabel(task)} has no Claude Code transcript: no Claude Code session is linked to it` +
            `${others.length ? ` (the transcripts of ${others.join(" and ")} can't be read here)` : ""}.`,
        );
      }
      let link: SessionLink | undefined;
      let others: string[] = [];
      if (session) {
        const wanted = session.trim().toLowerCase();
        link = sessions.find((l) => l.ref.sessionId === wanted);
        if (!link) {
          throw new AppError(
            "VALIDATION",
            `Session ${redact(session)} isn't linked to ${taskLabel(task)}. Linked Claude Code sessions: ${sessions.map(describe).join("; ")}.`,
          );
        }
      } else {
        // The newest link is the session that last worked on the task. Links come oldest first, so a tie goes to
        // the later one.
        link = sessions.reduce((newest, l) => (l.createdAt >= newest.createdAt ? l : newest));
        const chosen = link;
        others = sessions.filter((l) => l !== chosen).map(describe);
      }
      if (!link) throw new AppError("INTERNAL", "No session chosen");
      const ref: AgentSessionRef = link.ref;
      const remote = ref.machine ? (deps.onMachine?.(ref, offset ?? 0) ?? null) : null;
      const read = await (remote ?? readSession(ref, offset ?? 0));
      return {
        taskNumber: taskNumberValue(task),
        sessionId: ref.sessionId,
        label: link.label ?? null,
        ...(others.length ? { otherSessions: others } : {}),
        stats: read.stats,
        page: read.page,
      };
    },
  };
}
