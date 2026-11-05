import type { ProviderSetting, ProviderStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { canPrefer, cardRows } from "./tierCards.logic";

const on = (id: ProviderSetting["id"], enabled = true): ProviderSetting => ({ id, enabled, cliPath: null });
const cli = (found: boolean) =>
  ({ cli: { found, path: null, version: null, error: null } }) as unknown as ProviderStatus;

describe("cardRows", () => {
  it("keeps the Providers order and leaves out switched-off providers", () => {
    const rows = cardRows([on("codex"), on("t3-code", false), on("claude-code")], () => cli(true), {
      tokenSet: true,
      detected: true,
    });
    expect(rows.map((r) => r.provider)).toEqual(["codex", "claude-code"]);
    expect(rows.every((r) => r.state === "ready" && r.problem === null)).toBe(true);
    expect(rows[0]!.target).toBe("agents.providers.codex");
  });

  it("marks T3 Code offline until it is connected and running, pointing at the fix", () => {
    const unpaired = cardRows([on("t3-code")], () => undefined, { tokenSet: false, detected: true })[0]!;
    expect(unpaired).toMatchObject({ provider: "t3", state: "offline", problem: "Not connected" });
    expect(unpaired.target).toBe("agents.providers.t3-code.pairing");
    const stopped = cardRows([on("t3-code")], () => undefined, { tokenSet: true, detected: false })[0]!;
    expect(stopped).toMatchObject({ state: "offline", problem: "Not running" });
    const ready = cardRows([on("t3-code")], () => undefined, { tokenSet: true, detected: true })[0]!;
    expect(ready.state).toBe("ready");
  });

  it("keeps a CLI that isn't found settable, with the problem and a link to its path", () => {
    const row = cardRows([on("copilot-cli")], () => cli(false), { tokenSet: false, detected: false })[0]!;
    expect(row).toMatchObject({ state: "ready", problem: "CLI not found" });
    expect(row.target).toBe("agents.providers.copilot-cli.cli-path");
  });
});

describe("canPrefer", () => {
  it("is true for the CLIs only", () => {
    expect(canPrefer("claude-code")).toBe(true);
    expect(canPrefer("t3")).toBe(false);
  });
});
