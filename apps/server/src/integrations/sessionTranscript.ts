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
  taskNumber: number;
  sessionId: string;
  label: string | null;
  /** The other linked sessions, described, when none was asked for and the newest was read. */
  otherSessions?: string[];
  stats: TranscriptStats;
  page: TranscriptPage;
}

export interface SessionTranscriptReader {
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
}): SessionTranscriptReader {
  return {
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
          `#${task.number} has no Claude Code transcript: no Claude Code session is linked to it` +
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
            `Session ${redact(session)} isn't linked to #${task.number}. Linked Claude Code sessions: ${sessions.map(describe).join("; ")}.`,
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
      const path = transcriptPath(deps.claudeDir, ref.sessionId, ref.cwd);
      if (!path) {
        throw new AppError(
          "NOT_FOUND",
          `No transcript for session ${ref.sessionId} was found on this machine (it may have run elsewhere, or been cleaned up).`,
        );
      }
      // Each page reads and condenses the whole file again. No cache: a transcript is read a handful of times while an
      // agent audits it, condensing streams the file, and a live session's transcript changes between pages anyway.
      let condensed;
      try {
        condensed = await condenseTranscriptFile(path);
      } catch {
        throw new AppError("NOT_FOUND", `The transcript of session ${ref.sessionId} couldn't be read.`);
      }
      return {
        taskNumber: task.number,
        sessionId: ref.sessionId,
        label: link.label ?? null,
        ...(others.length ? { otherSessions: others } : {}),
        stats: condensed.stats,
        page: pageEntries(condensed.entries, offset ?? 0),
      };
    },
  };
}
