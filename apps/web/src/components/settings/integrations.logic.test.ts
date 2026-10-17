import type { GithubStatus, T3IntegrationStatus, TerminalInfo } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { claudeCodeDot, githubDot, jiraDot, t3Dot, terminalDot } from "./integrations.logic";

const t3 = (patch: Partial<T3IntegrationStatus> = {}): T3IntegrationStatus => ({
  detected: true,
  origin: "http://127.0.0.1:3773",
  environmentId: null,
  label: null,
  liveStatus: "ok",
  error: null,
  ...patch,
});

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

  it("Claude Code follows the CLI test", () => {
    expect(claudeCodeDot(undefined).tone).toBe("muted");
    expect(claudeCodeDot({ ok: true, path: "claude", version: "2" }).tone).toBe("success");
    expect(claudeCodeDot({ ok: false, error: "not found" }).tone).toBe("warning");
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
