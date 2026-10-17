import type { AgentIntegrationStatus, GithubStatus, T3IntegrationStatus, TerminalInfo } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { agentDot, githubDot, jiraDot, t3Dot, terminalDot } from "./integrations.logic";

const t3 = (patch: Partial<T3IntegrationStatus> = {}): T3IntegrationStatus => ({
  detected: true,
  origin: "http://127.0.0.1:3773",
  environmentId: null,
  label: null,
  liveStatus: "ok",
  error: null,
  ...patch,
});

const agent = (
  patch: { cli?: Partial<AgentIntegrationStatus["cli"]>; mcp?: Partial<AgentIntegrationStatus["mcp"]> } = {},
) =>
  ({
    harness: "claude-code",
    cli: { found: true, path: "/bin/claude", version: "2.0.0", error: null, ...patch.cli },
    mcp: { registered: true, connected: true, scope: "user", name: "aboard", detail: "Connected", ...patch.mcp },
  }) satisfies AgentIntegrationStatus;

const gh = (patch: Partial<GithubStatus> = {}): GithubStatus => ({
  available: true,
  authenticated: true,
  error: null,
  hosts: [],
  ...patch,
});

describe("integration dots", () => {
  it("T3 Code is green only once a saved token connects", () => {
    expect(t3Dot(undefined, true).tone).toBe("muted");
    expect(t3Dot(t3({ detected: false }), true).tone).toBe("muted");
    expect(t3Dot(t3(), false).tone).toBe("muted");
    expect(t3Dot(t3({ liveStatus: "error", error: "Bad token" }), true)).toEqual({
      tone: "warning",
      label: "Bad token",
    });
    expect(t3Dot(t3(), true).tone).toBe("success");
  });

  it("a CLI harness is green only when its CLI runs and the board's MCP is registered", () => {
    expect(agentDot("Claude Code", undefined)).toEqual({ tone: "muted", label: "Checking" });
    expect(agentDot("Claude Code", undefined, true)).toEqual({ tone: "warning", label: "Couldn't check Claude Code" });
    expect(agentDot("Claude Code", agent())).toEqual({ tone: "success", label: "Ready" });
    expect(agentDot("Claude Code", agent({ cli: { found: false, error: "claude isn't on PATH" } }))).toEqual({
      tone: "warning",
      label: "Claude Code CLI not working: claude isn't on PATH",
    });
    expect(agentDot("Claude Code", agent({ mcp: { registered: false, connected: null } }))).toEqual({
      tone: "warning",
      label: "MCP server not registered",
    });
  });

  it("an MCP server the harness can't confirm, or reports as down, doesn't turn a ready CLI amber", () => {
    expect(agentDot("Copilot", agent({ mcp: { connected: null } })).tone).toBe("success");
    // A project-only registration is amber: it is missing in every other folder.
    expect(agentDot("Claude Code", agent({ mcp: { scope: "local", connected: null } })).tone).toBe("warning");
    expect(agentDot("Claude Code", agent({ mcp: { scope: "local", connected: true } })).tone).toBe("success");
    const down = agentDot("Copilot", agent({ mcp: { connected: false } }));
    expect(down.tone).toBe("success");
    expect(down.label).toContain("not connected");
  });

  it("GitHub warns when gh is missing, signed out, or a host has expired", () => {
    expect(githubDot(gh()).tone).toBe("success");
    expect(githubDot(gh({ available: false })).tone).toBe("warning");
    expect(githubDot(gh({ authenticated: false })).tone).toBe("warning");
    expect(githubDot(gh({ hosts: [{ host: "ghe.example.com", authenticated: false, login: null }] })).tone).toBe(
      "warning",
    );
  });

  it("Jira and Terminal", () => {
    expect(jiraDot(null).tone).toBe("muted");
    expect(jiraDot("https://x.atlassian.net").tone).toBe("success");
    const info = { error: null } as TerminalInfo;
    expect(terminalDot(info).tone).toBe("success");
    expect(terminalDot({ ...info, error: "No terminal" }).tone).toBe("warning");
  });
});
