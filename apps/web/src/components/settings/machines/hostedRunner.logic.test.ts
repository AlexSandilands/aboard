import type { HostedRunnerStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { hostedRunnerLine, pairingAddresses, runsWarning } from "./hostedRunner.logic";

const status = (over: Partial<HostedRunnerStatus> = {}): HostedRunnerStatus => ({
  enabled: true,
  bind: "loopback",
  state: "running",
  error: null,
  port: 4318,
  url: "http://127.0.0.1:4318",
  tailscaleUrl: null,
  instanceId: "bf549746-2379-4a1c-98c5-6cb10f70aafb",
  name: "laptop",
  board: null,
  heldTasks: 0,
  runsInFlight: 0,
  ...over,
});

describe("hostedRunnerLine", () => {
  it("says it is off, starting, or why it couldn't start", () => {
    expect(hostedRunnerLine(status({ enabled: false, state: "off" })).tone).toBe("muted");
    expect(hostedRunnerLine(status({ state: "starting" })).text).toBe("Starting…");
    const failed = hostedRunnerLine(status({ state: "failed", error: "Port 4318 is in use." }));
    expect(failed).toMatchObject({ tone: "danger", text: "Port 4318 is in use." });
  });

  it("asks for a board until one pairs, then names it and what it holds", () => {
    expect(hostedRunnerLine(status())).toMatchObject({ tone: "warning", label: "Not paired" });
    const board = { instanceId: "5d6c0e4a-7d3e-4f0b-9a55-0a2b2b3c4d5e", name: "desk", pairedAt: "", lastUsedAt: null };
    expect(hostedRunnerLine(status({ board, heldTasks: 2, runsInFlight: 1 })).text).toBe(
      "Listening on port 4318. Runs tasks for desk, holding 2 tasks, 1 run going.",
    );
    expect(hostedRunnerLine(status({ board, tailscaleUrl: "http://100.64.0.7:4318" })).text).toBe(
      "Listening on port 4318 and on the tailnet. Runs tasks for desk.",
    );
  });
});

describe("pairingAddresses", () => {
  it("offers the tailnet address first when there is one", () => {
    expect(pairingAddresses({ url: "http://127.0.0.1:4318", tailscaleUrl: null }).map((a) => a.url)).toEqual([
      "http://127.0.0.1:4318",
    ]);
    expect(
      pairingAddresses({ url: "http://127.0.0.1:4318", tailscaleUrl: "http://100.64.0.7:4318" }).map((a) => a.url),
    ).toEqual(["http://100.64.0.7:4318", "http://127.0.0.1:4318"]);
  });
});

describe("runsWarning", () => {
  const board = { instanceId: "5d6c0e4a-7d3e-4f0b-9a55-0a2b2b3c4d5e", name: "desk", pairedAt: "", lastUsedAt: null };
  it("asks before stopping or restarting a runner with runs going, and not otherwise", () => {
    const busy = status({ board, runsInFlight: 2 });
    expect(runsWarning(busy, { enabled: false })).toEqual({
      text: "2 runs for desk are going here. Stopping the runner ends them.",
      action: "Stop anyway",
    });
    expect(runsWarning(busy, { bind: "private" })?.action).toBe("Restart anyway");
    expect(runsWarning(busy, { bind: "loopback" })).toBeNull();
    expect(runsWarning(status({ board }), { enabled: false })).toBeNull();
    expect(runsWarning(status({ state: "off", runsInFlight: 1 }), { enabled: true })).toBeNull();
  });
});
