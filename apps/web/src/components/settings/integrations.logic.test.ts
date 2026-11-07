import type { GitHostStatus, TerminalInfo } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { gitHostDot, terminalDot } from "./integrations.logic";

const gh = (patch: Partial<GitHostStatus> = {}): GitHostStatus => ({
  kind: "github",
  available: true,
  version: "2.96.0",
  authenticated: true,
  error: null,
  accounts: [],
  ...patch,
});

describe("integration dots", () => {
  it("GitHub warns when gh is missing, signed out, or a host has expired", () => {
    expect(gitHostDot(gh()).tone).toBe("success");
    expect(gitHostDot(gh({ available: false }))).toEqual({ tone: "warning", label: "gh not found" });
    expect(gitHostDot(gh({ authenticated: false })).tone).toBe("warning");
    expect(gitHostDot(gh({ accounts: [{ host: "ghe.example.com", authenticated: false, login: null }] })).tone).toBe(
      "warning",
    );
  });

  it("Terminal", () => {
    const info = { error: null } as TerminalInfo;
    expect(terminalDot(info).tone).toBe("success");
    expect(terminalDot({ ...info, error: "No terminal" }).tone).toBe("warning");
  });
});
