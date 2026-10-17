import type { AgentSessionRef, TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  folderName,
  isAutopilotSession,
  sessionName,
  sessionStatusPresentation,
  sessionTitle,
  sessionWarning,
  type SessionLink,
} from "./sessions.logic";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";

const link = (ref: Partial<AgentSessionRef> = {}, label: string | null = null): SessionLink =>
  ({
    id: "l",
    taskId: "t",
    url: "",
    label,
    syncedAt: null,
    createdAt: "",
    kind: "agent_session",
    ref: { harness: "claude-code", sessionId: ID, cwd: "C:\\Code\\aboard\\", ...ref },
    snapshot: null,
  }) satisfies TaskLink;

describe("sessions", () => {
  it("names a session by harness and folder", () => {
    expect(folderName("C:\\Code\\aboard\\")).toBe("aboard");
    expect(folderName("/home/me/x")).toBe("x");
    expect(folderName("/")).toBe("/");
    expect(sessionTitle(link())).toBe("Claude Code session in aboard");
    expect(sessionTitle(link({ harness: "copilot-cli" }, "Autopilot run"))).toBe("Autopilot run");
  });

  it("names a session by its label, else by the title its harness keeps", () => {
    const titled = (label: string | null, title: string | null): SessionLink => ({
      ...link({}, label),
      snapshot: { status: "idle", inApp: false, title },
    });
    expect(sessionName(titled("Implementing #7", "Fix the thing"))).toBe("Implementing #7");
    expect(sessionName(titled(null, "Fix the thing"))).toBe("Fix the thing");
    expect(sessionTitle(titled(null, "Fix the thing"))).toBe("Fix the thing");
    expect(sessionName(titled("  ", null))).toBeNull();
    expect(sessionName(link())).toBeNull();
  });

  it("tells an Autopilot session by its run's status or its name", () => {
    expect(isAutopilotSession(link())).toBe(false);
    expect(isAutopilotSession(link({}, "Implementing #7"))).toBe(false);
    expect(isAutopilotSession(link({}, "Autopilot · Review #7"))).toBe(true);
    expect(isAutopilotSession(link({}, "Autopilot session"))).toBe(true);
    expect(isAutopilotSession({ ...link(), snapshot: { status: "failed", inApp: false } })).toBe(true);
    expect(isAutopilotSession({ ...link(), snapshot: { status: "idle", inApp: false } })).toBe(false);
  });

  it("shows status unknown until the first read", () => {
    expect(sessionStatusPresentation(null).label).toBe("Status unknown");
    expect(sessionStatusPresentation({ status: "busy", inApp: false }).label).toBe("Working");
    expect(sessionStatusPresentation({ status: "not_running", inApp: false }).label).toBe("Not running");
  });

  it("shows an Autopilot session as finished or failed, with when it ended", () => {
    const endedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(sessionStatusPresentation({ status: "finished", inApp: false, endedAt }).label).toBe("Finished 5m ago");
    expect(sessionStatusPresentation({ status: "failed", inApp: false, endedAt }).label).toBe("Failed 5m ago");
    expect(sessionStatusPresentation({ status: "finished", inApp: false }).label).toBe("Finished");
  });

  it("offers fork for Claude and the T3 thread for a session inside T3", () => {
    const w = sessionWarning(link(), { status: "busy", inApp: true }, { hasThread: true });
    expect(w).toMatchObject({ canFork: true, offerThread: true });
    expect(w.body).toMatch(/inside T3 Code and working right now/);
    expect(w.body).toMatch(/Fork it/);
  });

  it("offers neither for a Copilot session in a terminal", () => {
    const w = sessionWarning(
      link({ harness: "copilot-cli" }),
      { status: "running", inApp: false },
      { hasThread: true },
    );
    expect(w).toMatchObject({ canFork: false, offerThread: false });
    expect(w.body).not.toMatch(/Fork/);
  });
});
