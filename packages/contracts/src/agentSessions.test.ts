import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESSES,
  LAUNCHABLE_HARNESSES,
  agentSessionUrl,
  AgentSessionRef,
  canFork,
  isAbsolutePath,
  isRunningSession,
  LaunchToken,
  resumeArgv,
  selfLinkLine,
  startedSessionLine,
  TerminalSetting,
  withLaunchToken,
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

  it("refuses to fork a Codex session, but starts one from the board that links itself", () => {
    expect(canFork("codex")).toBe(false);
    expect(() => resumeArgv({ harness: "codex", sessionId: ID }, "fork")).toThrow(/can't be forked/);
    expect(LAUNCHABLE_HARNESSES).toEqual(["claude-code", "codex", "copilot-cli"]);
  });

  it("tells a session the board couldn't link to link itself, and one it linked not to", () => {
    const self = startedSessionLine("codex", "Implementing #4");
    expect(self).toBe(selfLinkLine("codex", "Implementing #4"));
    expect(self).toContain(
      'link(agentSession: {harness: "codex", sessionId: $CODEX_THREAD_ID, cwd: your working directory}, label: "Implementing #4")',
    );
    expect(startedSessionLine("codex", "Planning #3, #4", "every task")).toContain(
      'link it to every task yourself first with link(task, agentSession: {harness: "codex"',
    );
    expect(startedSessionLine("claude-code", "Implementing #4")).toBe(
      "The board started this session and already linked it to the task; don't link it again.",
    );
    expect(startedSessionLine(null, "Orchestrating #4", "the epic")).toContain("already linked it to the epic");
  });

  it("forks into a session id it is given only where the CLI takes one", () => {
    const NEW = "0b9b8f9e-2a43-4c55-9d3a-6f2c1e7d8a90";
    expect(resumeArgv({ harness: "claude-code", sessionId: ID }, "fork", NEW)).toEqual([
      "claude",
      "--resume",
      ID,
      "--fork-session",
      "--session-id",
      NEW,
    ]);
    expect(AGENT_HARNESSES.codex.forkIntoArgs).toBeNull();
    expect(AGENT_HARNESSES["copilot-cli"].forkIntoArgs).toBeNull();
  });

  it("puts a launch token into the self-link call, or says to pass it when the prompt has none", () => {
    const token = "a1b2c3d4e5f6a7b8c9";
    expect(LaunchToken.safeParse(token).success).toBe(true);
    expect(LaunchToken.safeParse("app-0b9b8f9e2a43").success).toBe(false);
    expect(selfLinkLine("codex", "Implementing #4", "the task", token)).toContain(
      `label: "Implementing #4", launch: "${token}"), so it can be reopened`,
    );
    const prompt = `Let's work on #4. ${selfLinkLine("codex", "Implementing #4")} Then read the plan.`;
    expect(withLaunchToken(prompt, "codex", token)).toBe(
      `Let's work on #4. ${selfLinkLine("codex", "Implementing #4", "the task", token)} Then read the plan.`,
    );
    const rewritten = withLaunchToken("Just fix the bug.", "codex", token);
    expect(rewritten).toMatch(
      /^Just fix the bug\.\n\nWhen you link this session, also pass launch: "a1b2c3d4e5f6a7b8c9"/,
    );
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
