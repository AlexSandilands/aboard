import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESSES,
  LAUNCHABLE_HARNESSES,
  agentSessionUrl,
  AgentSessionRef,
  canFork,
  isAbsolutePath,
  isRunningSession,
  resumeArgv,
  TerminalSetting,
} from "./agentSessions.ts";
import { TaskLink } from "./schemas.ts";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";

describe("AgentSessionRef", () => {
  it("accepts a UUID and an absolute path, lower-casing the id", () => {
    const ref = AgentSessionRef.parse({ harness: "claude-code", sessionId: ID.toUpperCase(), cwd: "C:\\Code\\x" });
    expect(ref.sessionId).toBe(ID);
  });

  it.each(["not-a-uuid", `${ID}; rm -rf /`, `${ID}&calc`, `"${ID}"`, ""])("rejects session id %j", (sessionId) => {
    expect(AgentSessionRef.safeParse({ harness: "claude-code", sessionId, cwd: "/home/x" }).success).toBe(false);
  });

  it.each([
    ["C:\\Code\\repo\\", "C:\\Code\\repo"],
    ["/home/me/repo//", "/home/me/repo"],
    ["C:\\", "C:\\"],
    ["C:/", "C:/"],
    ["/", "/"],
  ])("trims trailing separators from %j but keeps a root", (cwd, expected) => {
    expect(AgentSessionRef.parse({ harness: "claude-code", sessionId: ID, cwd }).cwd).toBe(expected);
  });

  it("rejects relative folders and unknown harnesses", () => {
    expect(AgentSessionRef.safeParse({ harness: "claude-code", sessionId: ID, cwd: "repo" }).success).toBe(false);
    expect(AgentSessionRef.safeParse({ harness: "gemini", sessionId: ID, cwd: "/x" }).success).toBe(false);
  });
});

describe("isAbsolutePath", () => {
  it.each([
    ["C:\\Code", true],
    ["c:/code", true],
    ["\\\\server\\share", true],
    ["/home/me", true],
    ["Code", false],
    ["C:", false],
    ["..\\x", false],
    ["\\\\", false],
  ])("%s → %s", (path, expected) => expect(isAbsolutePath(path)).toBe(expected));
});

describe("harness table", () => {
  it("builds resume and fork commands", () => {
    expect(resumeArgv({ harness: "claude-code", sessionId: ID }, "resume")).toEqual(["claude", "--resume", ID]);
    expect(resumeArgv({ harness: "claude-code", sessionId: ID }, "fork")).toEqual([
      "claude",
      "--resume",
      ID,
      "--fork-session",
    ]);
    expect(resumeArgv({ harness: "copilot-cli", sessionId: ID }, "resume")).toEqual(["copilot", `--resume=${ID}`]);
    expect(resumeArgv({ harness: "codex", sessionId: ID }, "resume")).toEqual(["codex", "resume", ID]);
  });

  it("refuses to fork a Codex session, and starts none from the board", () => {
    expect(canFork("codex")).toBe(false);
    expect(() => resumeArgv({ harness: "codex", sessionId: ID }, "fork")).toThrow(/can't be forked/);
    expect(LAUNCHABLE_HARNESSES).toEqual(["claude-code", "copilot-cli"]);
  });

  it("refuses to fork a Copilot session", () => {
    expect(canFork("copilot-cli")).toBe(false);
    expect(canFork("claude-code")).toBe(true);
    expect(() => resumeArgv({ harness: "copilot-cli", sessionId: ID }, "fork")).toThrow(/can't be forked/);
  });

  it("names each harness's session id variable", () => {
    expect(AGENT_HARNESSES["claude-code"].idEnvVar).toBe("CLAUDE_CODE_SESSION_ID");
    expect(AGENT_HARNESSES["copilot-cli"].idEnvVar).toBe("COPILOT_AGENT_SESSION_ID");
    expect(AGENT_HARNESSES.codex.idEnvVar).toBe("CODEX_THREAD_ID");
  });

  it("gives each session one URL however the id is cased", () => {
    expect(agentSessionUrl({ harness: "claude-code", sessionId: ID.toUpperCase() })).toBe(
      `agent-session://claude-code/${ID}`,
    );
  });

  it("treats busy, idle and running as running", () => {
    expect(["busy", "idle", "running"].every((s) => isRunningSession(s as never))).toBe(true);
    expect(isRunningSession("not_running")).toBe(false);
    expect(isRunningSession("unknown")).toBe(false);
    expect(isRunningSession(undefined)).toBe(false);
  });
});

describe("TerminalSetting", () => {
  it("needs {command} in a custom template", () => {
    expect(TerminalSetting.safeParse({ kind: "custom", template: "alacritty -e" }).success).toBe(false);
    expect(TerminalSetting.safeParse({ kind: "custom", template: "alacritty -e {command}" }).success).toBe(true);
  });
});

describe("agent_session links", () => {
  it("parse with and without a snapshot", () => {
    const base = {
      id: "l1",
      taskId: "t1",
      url: `agent-session://claude-code/${ID}`,
      label: null,
      syncedAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      kind: "agent_session",
      ref: { harness: "claude-code", sessionId: ID, cwd: "C:\\Code" },
    };
    expect(TaskLink.safeParse({ ...base, snapshot: null }).success).toBe(true);
    expect(TaskLink.safeParse({ ...base, snapshot: { status: "busy", inApp: true } }).success).toBe(true);
  });
});
