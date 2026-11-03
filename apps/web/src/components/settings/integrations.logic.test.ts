import type { GithubStatus, TerminalInfo } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { githubDot, terminalDot } from "./integrations.logic";

const gh = (patch: Partial<GithubStatus> = {}): GithubStatus => ({
  available: true,
  authenticated: true,
  error: null,
  hosts: [],
  ...patch,
});

describe("integration dots", () => {
  it("GitHub warns when gh is missing, signed out, or a host has expired", () => {
    expect(githubDot(gh()).tone).toBe("success");
    expect(githubDot(gh({ available: false })).tone).toBe("warning");
    expect(githubDot(gh({ authenticated: false })).tone).toBe("warning");
    expect(githubDot(gh({ hosts: [{ host: "ghe.example.com", authenticated: false, login: null }] })).tone).toBe(
      "warning",
    );
  });

  it("Terminal", () => {
    const info = { error: null } as TerminalInfo;
    expect(terminalDot(info).tone).toBe("success");
    expect(terminalDot({ ...info, error: "No terminal" }).tone).toBe("warning");
  });
});
