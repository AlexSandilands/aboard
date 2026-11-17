import type { Machine } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  asSentence,
  directRouteFrom,
  machineSummary,
  moveRoute,
  nameFromTarget,
  t3Line,
  untilLabel,
  versionLine,
} from "./machines.logic";

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: "m1",
  instanceId: "bf549746-2379-4a1c-98c5-6cb10f70aafb",
  name: "engine",
  prefix: "E",
  prefixFixed: false,
  routes: [
    { kind: "ssh", target: "alex@engine", port: null, remotePort: 4318 },
    { kind: "direct", url: "http://100.101.102.103:4318" },
  ],
  connection: "connected",
  error: null,
  activeRoute: 0,
  routeStates: [
    { status: "active", error: null, retryAt: null },
    { status: "standby", error: null, retryAt: null },
  ],
  version: "1.4.2",
  protocolVersion: 1,
  platform: "linux-x64",
  logins: [
    { name: "claude", state: "ok", detail: null },
    { name: "gh", state: "ok", detail: null },
  ],
  runsInFlight: 0,
  selfUpdate: true,
  t3: { state: "connected", detail: null },
  updatesWithApp: false,
  update: null,
  versionState: "same",
  lastSeenAt: "2026-11-15T10:00:00.000Z",
  createdAt: "2026-11-14T10:00:00.000Z",
  ...over,
});

describe("a machine's row", () => {
  it("is one quiet line while nothing is wrong", () => {
    expect(machineSummary(machine({ runsInFlight: 2 }))).toEqual({
      tone: "success",
      text: "Connected over SSH · 2 runs",
      badges: [],
      attention: false,
    });
    expect(machineSummary(machine({ activeRoute: 1 })).text).toBe("Connected over Tailscale");
    const direct = (url: string) => machineSummary(machine({ routes: [{ kind: "direct", url }], activeRoute: 0 })).text;
    expect(direct("http://engine.tail1234.ts.net:4318")).toBe("Connected over Tailscale");
    expect(direct("https://engine.example.com")).toBe("Connected directly");
    expect(direct("http://100.20.1.1:4318")).toBe("Connected directly");
  });

  it("names what is missing and opens by itself", () => {
    const summary = machineSummary(
      machine({
        logins: [
          { name: "claude", state: "ok", detail: null },
          { name: "codex", state: "missing", detail: null },
          { name: "gh", state: "logged-out", detail: null },
          // A check that didn't finish isn't a missing login.
          { name: "git", state: "unknown", detail: null },
        ],
      }),
    );
    expect(summary.badges).toEqual([{ tone: "warning", label: "2 logins missing" }]);
    expect(summary.attention).toBe(true);
  });

  it("says how it stands when it isn't connected", () => {
    const of = (connection: Machine["connection"]) => machineSummary(machine({ connection, activeRoute: null }));
    expect(of("unreachable")).toMatchObject({ tone: "danger", text: "Can't be reached", attention: true });
    expect(of("needs-update")).toMatchObject({ tone: "warning", text: "Needs updating", attention: true });
    expect(of("unpaired")).toMatchObject({ tone: "warning", text: "Not paired", attention: true });
    expect(of("connecting")).toMatchObject({ tone: "muted", text: "Connecting", attention: false });
  });

  it("badges an update, and opens only for one that failed", () => {
    const of = (state: NonNullable<Machine["update"]>["state"]) =>
      machineSummary(machine({ update: { state, targetVersion: "1.4.3", error: null } }));
    expect(of("waiting")).toMatchObject({ badges: [{ tone: "info", label: "Update waiting" }], attention: false });
    expect(of("downloading").badges).toEqual([{ tone: "info", label: "Updating" }]);
    expect(of("failed")).toMatchObject({ badges: [{ tone: "error", label: "Update failed" }], attention: true });
  });
});

describe("the version line", () => {
  const update = (state: NonNullable<Machine["update"]>["state"], error: string | null = null) => ({
    state,
    targetVersion: "1.5.0",
    error,
  });

  it("says the machine follows the board when they match", () => {
    expect(versionLine(machine(), "1.4.2")).toEqual({
      badge: null,
      text: "1.4.2, the same as this board. Updates follow the board by themselves.",
      action: null,
    });
  });

  it("offers to skip the wait while runs hold an update back", () => {
    const line = versionLine(machine({ update: update("waiting"), runsInFlight: 1, versionState: "older" }), "1.5.0");
    expect(line.text).toBe("1.4.2 → 1.5.0 once its 1 run finishes.");
    expect(line.action).toEqual({ label: "Update now", now: true, hint: "Ends the runs in flight." });
    expect(
      versionLine(machine({ update: update("waiting"), runsInFlight: 3, versionState: "older" }), "1.5.0").text,
    ).toBe("1.4.2 → 1.5.0 once its 3 runs finish.");
  });

  it("gives the reason an update failed and a way to try again", () => {
    const line = versionLine(machine({ update: update("failed", "The download doesn't match its checksum") }), "1.5.0");
    expect(line.text).toBe("Still on 1.4.2. The download doesn't match its checksum");
    expect(line.action).toMatchObject({ label: "Try again", now: false });
  });

  it("never offers to move a newer machine back, or to update one that can't update itself", () => {
    expect(versionLine(machine({ version: "1.6.0", versionState: "newer" }), "1.5.0")).toMatchObject({
      badge: { label: "Newer than this board" },
      action: null,
    });
    const byHand = versionLine(machine({ versionState: "older", selfUpdate: false }), "1.5.0");
    expect(byHand.action).toBeNull();
    expect(byHand.text).toContain("install command");
    expect(versionLine(machine({ versionState: "older" }), "1.5.0").action).toMatchObject({ label: "Update" });
  });

  it("sends the user to the app for a machine that runs tasks inside it", () => {
    const behind = versionLine(machine({ versionState: "older", updatesWithApp: true }), "1.5.0");
    expect(behind.action).toBeNull();
    expect(behind.text).toContain("update");
    expect(behind.text).toContain("on engine");
    expect(versionLine(machine({ updatesWithApp: true }), "1.4.2").text).toContain("updates with it");
  });
});

describe("routes", () => {
  it("move one place up or down and stay put at the ends", () => {
    const [ssh, direct] = machine().routes;
    expect(moveRoute([ssh!, direct!], 1, -1)).toEqual([direct, ssh]);
    expect(moveRoute([ssh!, direct!], 0, 1)).toEqual([direct, ssh]);
    expect(moveRoute([ssh!, direct!], 0, -1)).toEqual([ssh, direct]);
    expect(moveRoute([ssh!, direct!], 1, 1)).toEqual([ssh, direct]);
  });

  it("are made from an address as typed", () => {
    expect(directRouteFrom(" 100.101.102.103:4318 ")).toEqual({ kind: "direct", url: "http://100.101.102.103:4318" });
    expect(directRouteFrom("https://engine.example.com/")).toEqual({
      kind: "direct",
      url: "https://engine.example.com",
    });
    expect(directRouteFrom("")).toBeNull();
    expect(directRouteFrom("not a url")).toBeNull();
  });

  it("say when a failed one is tried next", () => {
    const now = Date.parse("2026-11-15T10:00:00.000Z");
    expect(untilLabel("2026-11-15T10:00:40.000Z", now)).toBe("40s");
    expect(untilLabel("2026-11-15T10:01:20.000Z", now)).toBe("1m 20s");
    expect(untilLabel("2026-11-15T10:02:00.000Z", now)).toBe("2m");
    expect(untilLabel("2026-11-15T09:59:00.000Z", now)).toBe("a moment");
    expect(untilLabel(null, now)).toBe("a moment");
  });
});

describe("an error shown before more text", () => {
  it("ends in one full stop", () => {
    expect(asSentence("ssh engine: Connection refused")).toBe("ssh engine: Connection refused.");
    expect(asSentence("Run `ssh engine` once, then try again. ")).toBe("Run `ssh engine` once, then try again.");
  });
});

describe("the name of a machine added over SSH", () => {
  it("is the host part of the destination", () => {
    expect(nameFromTarget(" alex@engine ")).toBe("engine");
    expect(nameFromTarget("engine")).toBe("engine");
  });
});

describe("the machine's T3 Code", () => {
  it("names each state in its badge, and offers to connect", () => {
    const line = (state: NonNullable<Machine["t3"]>["state"], detail: string | null = null) =>
      t3Line(machine({ t3: { state, detail } }));
    expect(line("connected")).toMatchObject({ badge: { label: "Connected", tone: "success" }, connect: true });
    expect(line("read-only")).toMatchObject({ badge: { label: "Read-only", tone: "warning" }, connect: true });
    expect(line("read-only").text).toContain("“Operate tasks”");
    expect(line("not-connected").text).toContain("T3 Code on engine under Settings → Connections");
    expect(line("not-running")).toMatchObject({ badge: { label: "Not running" }, connect: true });
    expect(line("error", "Token expired or revoked. Paste a new pairing link")).toMatchObject({
      badge: { label: "Connection refused", tone: "error" },
      text: expect.stringMatching(
        /^Token expired or revoked\. Paste a new pairing link\. Create a new pairing link in T3/,
      ),
    });
  });

  it("isn't read until the machine is connected", () => {
    expect(t3Line(machine({ connection: "unreachable", t3: null }))).toEqual({
      badge: null,
      text: "Read once the machine is connected.",
      connect: false,
    });
  });

  it("asks for an update on a runner that can't report it", () => {
    expect(t3Line(machine({ t3: null }))).toMatchObject({ badge: null, connect: false });
    expect(t3Line(machine({ t3: null })).text).toContain("update it first");
  });

  it("sends a machine that is itself a board to that board's Settings", () => {
    const line = t3Line(machine({ updatesWithApp: true }));
    expect(line.connect).toBe(false);
    expect(line.badge?.label).toBe("Connected");
    expect(line.text).toMatch(/^engine runs tasks inside .+ there, which shares its T3 Code connection/);
  });
});
