import type { ProviderSetting, ProviderStatus, ProvidersStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  activeHarnesses,
  addableProviders,
  agentClisOf,
  askUnavailableReason,
  cliDot,
  detectionLabel,
  patchProvider,
  providerDot,
  providerSubtitle,
  selectedProvider,
  t3Dot,
  versionOf,
  withoutProvider,
  withProvider,
} from "./providers.logic";

const t3 = (patch: Partial<NonNullable<ProviderStatus["t3"]>> = {}): ProviderStatus => ({
  id: "t3-code",
  cli: null,
  mcp: null,
  models: null,
  t3: {
    detected: true,
    origin: "http://127.0.0.1:3773",
    label: null,
    liveStatus: "ok",
    error: null,
    tokenSet: true,
    ...patch,
  },
});

const agent = (
  patch: { cli?: Partial<NonNullable<ProviderStatus["cli"]>>; mcp?: Partial<NonNullable<ProviderStatus["mcp"]>> } = {},
): ProviderStatus => ({
  id: "claude-code",
  cli: { found: true, path: "/bin/claude", version: "2.1.30 (Claude Code)", error: null, ...patch.cli },
  mcp: { registered: true, connected: true, scope: "user", name: "aboard", detail: "Connected", ...patch.mcp },
  t3: null,
  models: null,
});

const on = (id: ProviderSetting["id"], enabled = true): ProviderSetting => ({ id, enabled, cliPath: null });

describe("provider dots", () => {
  it("T3 Code is green only once a saved token connects", () => {
    expect(t3Dot(undefined).tone).toBe("muted");
    expect(t3Dot(t3({ detected: false }).t3).tone).toBe("muted");
    expect(t3Dot(t3({ tokenSet: false }).t3).tone).toBe("muted");
    expect(t3Dot(t3({ liveStatus: "error", error: "Bad token" }).t3)).toEqual({ tone: "warning", label: "Bad token" });
    expect(t3Dot(t3().t3).tone).toBe("success");
  });

  it("a CLI provider is green only when its CLI runs and the board's MCP is registered", () => {
    expect(cliDot("Claude Code", undefined)).toEqual({ tone: "muted", label: "Checking" });
    expect(cliDot("Claude Code", undefined, true)).toEqual({ tone: "warning", label: "Couldn't check Claude Code" });
    expect(cliDot("Claude Code", agent())).toEqual({ tone: "success", label: "Ready" });
    expect(cliDot("Claude Code", agent({ cli: { found: false, error: "claude isn't on PATH" } }))).toEqual({
      tone: "warning",
      label: "Claude Code CLI not working: claude isn't on PATH",
    });
    expect(cliDot("Claude Code", agent({ mcp: { registered: false, connected: null } }))).toEqual({
      tone: "warning",
      label: "MCP server not registered",
    });
  });

  it("an MCP server the harness can't confirm, or reports as down, doesn't turn a ready CLI amber", () => {
    expect(cliDot("Copilot", agent({ mcp: { connected: null } })).tone).toBe("success");
    // A project-only registration is amber: it is missing in every other folder.
    expect(cliDot("Claude Code", agent({ mcp: { scope: "local", connected: null } })).tone).toBe("warning");
    const down = cliDot("Copilot", agent({ mcp: { connected: false } }));
    expect(down.tone).toBe("success");
    expect(down.label).toContain("not connected");
  });

  it("a provider switched off is grey whatever detection says", () => {
    expect(providerDot("claude-code", agent(), { enabled: false })).toEqual({ tone: "muted", label: "Off" });
    expect(providerDot("claude-code", agent(), { enabled: true }).tone).toBe("success");
    expect(providerDot("t3-code", t3(), { enabled: true }).tone).toBe("success");
    expect(providerDot("t3-code", undefined, undefined, true).tone).toBe("warning");
  });
});

describe("the provider list", () => {
  it("shows the CLI's version, or T3 Code's name, under each provider", () => {
    expect(providerSubtitle("claude-code", agent())).toBe("v2.1.30");
    expect(providerSubtitle("claude-code", agent({ cli: { found: false } }))).toBe("CLI not found");
    expect(providerSubtitle("t3-code", t3({ label: "Laptop" }))).toBe("Laptop");
    expect(providerSubtitle("t3-code", t3({ detected: false }))).toBe("Not running");
    expect(providerSubtitle("codex", undefined)).toBeNull();
    expect(versionOf("copilot 1.0.3-beta.2")).toBe("v1.0.3-beta.2");
    expect(versionOf("unknown")).toBe("unknown");
  });

  it("selects the provider in the URL, else the first added, else none", () => {
    const added = [on("claude-code"), on("codex")];
    expect(selectedProvider(added, "codex")).toBe("codex");
    // One not added yet still shows, so a search result can offer to add it.
    expect(selectedProvider(added, "t3-code")).toBe("t3-code");
    expect(selectedProvider(added, "gemini")).toBe("claude-code");
    expect(selectedProvider(added, null)).toBe("claude-code");
    expect(selectedProvider([], null)).toBeNull();
  });

  it("adds at the end, switches, and removes without touching the others", () => {
    const list = [on("codex")];
    expect(withProvider(list, "t3-code")).toEqual([on("codex"), on("t3-code")]);
    expect(withProvider(list, "codex")).toEqual(list);
    expect(patchProvider(list, "codex", { enabled: false, cliPath: "/opt/codex" })).toEqual([
      { id: "codex", enabled: false, cliPath: "/opt/codex" },
    ]);
    expect(withoutProvider([on("codex"), on("t3-code")], "codex")).toEqual([on("t3-code")]);
  });

  it("offers the harnesses that are added and on to the model pickers", () => {
    expect(activeHarnesses({ providers: [on("t3-code"), on("copilot-cli"), on("codex", false)] })).toEqual([
      "copilot-cli",
    ]);
    expect(activeHarnesses(undefined)).toEqual([]);
  });
});

describe("the Add provider dialog", () => {
  it("offers only the providers not added yet, in the registry's order", () => {
    expect(addableProviders([])).toEqual(["t3-code", "claude-code", "codex", "copilot-cli"]);
    expect(addableProviders([on("copilot-cli"), on("t3-code", false)])).toEqual(["claude-code", "codex"]);
  });

  it("says whether each is installed here", () => {
    expect(detectionLabel("claude-code", agent())).toEqual({ tone: "success", label: "Installed · v2.1.30" });
    expect(detectionLabel("claude-code", agent({ cli: { found: false } }))).toEqual({
      tone: "muted",
      label: "Not found",
    });
    expect(detectionLabel("t3-code", t3()).label).toBe("Running");
    expect(detectionLabel("codex", undefined).label).toBe("Checking…");
  });
});

describe("agentClisOf", () => {
  it("maps the providers' CLI checks to the harnesses, whether or not they are added", () => {
    const status: ProvidersStatus = {
      mcpUrl: "http://127.0.0.1:4317/mcp",
      checkedAt: "",
      providers: [t3(), agent(), { id: "codex", cli: null, mcp: null, t3: null, models: null }],
    };
    expect(agentClisOf(status)).toEqual([
      { harness: "claude-code", available: true, path: "/bin/claude" },
      { harness: "codex", available: false, path: null },
      { harness: "copilot-cli", available: false, path: null },
    ]);
    expect(agentClisOf(undefined)).toBeUndefined();
  });
});

describe("askUnavailableReason", () => {
  it("needs Claude Code added, on, and its CLI found", () => {
    expect(askUnavailableReason(undefined, undefined)).toBeNull();
    expect(askUnavailableReason({ providers: [] }, agent())).toContain("Add Claude Code");
    expect(askUnavailableReason({ providers: [on("claude-code", false)] }, agent())).toContain("switched off");
    expect(askUnavailableReason({ providers: [on("claude-code")] }, undefined)).toBeNull();
    expect(askUnavailableReason({ providers: [on("claude-code")] }, agent())).toBeNull();
    expect(
      askUnavailableReason(
        { providers: [{ id: "claude-code", enabled: true, cliPath: "/opt/claude" }] },
        agent({ cli: { found: false } }),
      ),
    ).toBe("The Claude Code CLI wasn't found at /opt/claude.");
  });
});
