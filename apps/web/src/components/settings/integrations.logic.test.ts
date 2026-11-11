import type { GitHostStatus, TerminalInfo } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { gitHostDot, modelPricesDot, modelPricesLine, terminalDot } from "./integrations.logic";

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

describe("model prices", () => {
  const base = { models: 242, lastFailedAt: null } as const;
  const rel = (iso: string) => `at ${iso}`;

  it("says which prices estimates use, and a failed fetch", () => {
    const fresh = { ...base, source: "litellm", asOf: "T1", status: "fresh" } as const;
    expect(modelPricesLine(fresh, rel)).toBe("LiteLLM's prices for 242 models, fetched at T1.");
    expect(modelPricesDot(fresh).tone).toBe("success");
    const failed = { ...fresh, status: "cached", lastFailedAt: "T2" } as const;
    expect(modelPricesLine(failed, rel)).toBe(
      "LiteLLM's prices for 242 models, fetched at T1. The last fetch failed at T2.",
    );
    expect(modelPricesDot(failed).tone).toBe("warning");
    const none = {
      models: null,
      lastFailedAt: null,
      source: "built_in",
      asOf: "2026-11-11",
      status: "unavailable",
    } as const;
    expect(modelPricesLine(none, rel)).toBe(
      "Nothing fetched yet, so estimates use the board's built-in prices (as of 2026-11-11).",
    );
    const off = { ...none, status: "off" } as const;
    expect(modelPricesLine(off, rel)).toBe("Estimates use the board's built-in prices (as of 2026-11-11).");
    expect(modelPricesDot(off).tone).toBe("muted");
    expect(modelPricesDot(undefined).label).toBe("Checking");
  });
});
