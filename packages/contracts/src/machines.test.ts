import { describe, expect, it } from "vitest";
import { BRAND, brandEnv } from "./brand.ts";
import {
  ConnectMachineInput,
  ConnectMachineT3Input,
  MachinePrefix,
  MachineT3Offer,
  MachineStatus,
  SshTarget,
  UpdateMachineRequest,
  compareReleaseVersions,
  machineRouteLabel,
  suggestMachinePrefix,
} from "./machines.ts";
import { runnerInstallCommand, runnerInstallScript, serverPlatformOf } from "./runnerInstall.ts";

describe("machine prefixes", () => {
  it("are one to three capitals or digits starting with a letter", () => {
    expect(MachinePrefix.parse(" e ")).toBe("E");
    expect(MachinePrefix.parse("e2")).toBe("E2");
    expect(MachinePrefix.safeParse("7E").success).toBe(false);
    expect(MachinePrefix.safeParse("ABCD").success).toBe(false);
    expect(MachinePrefix.safeParse("").success).toBe(false);
  });

  it("are suggested from the name, skipping the ones taken", () => {
    expect(suggestMachinePrefix("engine", [])).toBe("E");
    expect(suggestMachinePrefix("engine", ["E"])).toBe("EN");
    expect(suggestMachinePrefix("engine", ["e", "EN", "EG", "EI", "EE"])).toBe("E2");
    expect(suggestMachinePrefix("42", [])).toBe("M");
    expect(suggestMachinePrefix("mac-mini", ["M"])).toBe("MA");
  });
});

describe("ssh targets", () => {
  it("take a host, user@host or config name, and nothing ssh would read as an option", () => {
    const accepted = (target: string) => SshTarget.safeParse(target).success;
    expect(["engine", "alex@engine.local", "alex@[fd7a::1]", "10.0.0.2"].filter((t) => !accepted(t))).toEqual([]);
    expect(["-oProxyCommand=sh", "engine; rm -rf ~", "a b", "$(id)", ""].filter(accepted)).toEqual([]);
  });

  it("label a route as it is reached", () => {
    expect(machineRouteLabel({ kind: "ssh", target: "engine", port: 2222, remotePort: 4318 })).toBe("ssh engine:2222");
    expect(machineRouteLabel({ kind: "direct", url: "http://100.1.2.3:4318" })).toBe("http://100.1.2.3:4318");
  });

  it("fill in a connect request's defaults", () => {
    expect(ConnectMachineInput.parse({ via: "ssh", target: "engine" })).toEqual({
      via: "ssh",
      target: "engine",
      tailscale: false,
    });
  });
});

describe("release versions", () => {
  it("compare by number, with a pre-release before its release", () => {
    expect(compareReleaseVersions("1.4.2", "1.4.2")).toBe(0);
    expect(compareReleaseVersions("1.4.2", "1.10.0")).toBe(-1);
    expect(compareReleaseVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareReleaseVersions("1.5.0-beta.1", "1.5.0")).toBe(-1);
    expect(compareReleaseVersions("1.5.0", "1.5.0-beta.1")).toBe(1);
  });

  it("are all an update may name", () => {
    expect(UpdateMachineRequest.parse({ version: "1.4.2" })).toEqual({ version: "1.4.2", now: false });
    const accepted = (version: string) => UpdateMachineRequest.safeParse({ version }).success;
    expect(["../1.0.0", "1.0", "v1.0.0", "1.0.0/x", "latest"].filter(accepted)).toEqual([]);
  });

  it("map Node's platform and arch to a release platform", () => {
    expect(serverPlatformOf("linux", "x64")).toBe("linux-x64");
    expect(serverPlatformOf("darwin", "arm64")).toBe("darwin-arm64");
    expect(serverPlatformOf("win32", "x64")).toBeNull();
  });
});

describe("machine status", () => {
  it("drops a login this version doesn't know", () => {
    const status = MachineStatus.parse({
      version: "1.4.2",
      platform: "linux-x64",
      runsInFlight: 0,
      logins: [
        { name: "gh", state: "ok", detail: null },
        { name: "jj", state: "ok", detail: null },
      ],
      update: { state: "idle", targetVersion: null, error: null },
      selfUpdate: true,
    });
    expect(status.logins.map((l) => l.name)).toEqual(["gh"]);
  });

  const base = {
    version: "1.4.2",
    platform: "linux-x64",
    runsInFlight: 0,
    logins: [],
    update: { state: "idle", targetVersion: null, error: null },
    selfUpdate: true,
  };

  it("reads a runner's T3 Code, and one from before it reported none", () => {
    expect(MachineStatus.parse(base).t3).toBeNull();
    expect(MachineStatus.parse({ ...base, t3: { state: "read-only", detail: null } }).t3).toEqual({
      state: "read-only",
      detail: null,
    });
  });

  it("drops only the T3 part when its state is one this version doesn't know", () => {
    const status = MachineStatus.parse({ ...base, t3: { state: "sleeping", detail: null } });
    expect(status.t3).toBeNull();
    expect(status.version).toBe("1.4.2");
  });
});

describe("connecting a machine's T3 Code", () => {
  it("takes a pairing link or token, trimmed", () => {
    expect(ConnectMachineT3Input.parse({ value: "  t3code://app/pair#token=ABC  " }).value).toBe(
      "t3code://app/pair#token=ABC",
    );
    expect(ConnectMachineT3Input.safeParse({ value: "   " }).success).toBe(false);
  });

  it("reads the offer a session error carries only when it names the machine", () => {
    expect(MachineT3Offer.safeParse({ t3: "offer", machineId: "m1" }).success).toBe(true);
    expect(MachineT3Offer.safeParse({ t3: "offer" }).success).toBe(false);
  });
});

describe("the runner install script", () => {
  const script = runnerInstallScript("1.4.2");

  it("installs the version it was published with, under the brand's names", () => {
    expect(script).toContain('version="1.4.2"');
    expect(script).toContain(`${BRAND.id}-server-$version-$platform`);
    expect(script).toContain(`${brandEnv("BIND")}="$bind"`);
    expect(script).toContain("/releases/download/v$version");
  });

  it("never reads stdin, so it can be piped into sh", () => {
    // Every program that could read the script's own text off stdin is given /dev/null.
    const readers = script
      .split("\n")
      .filter((line) => /^\s*(curl|"\$bin\/)/.test(line) || /tailscale ip|-lic/.test(line));
    expect(readers.length).toBeGreaterThan(4);
    expect(readers.filter((line) => !line.includes("</dev/null"))).toEqual([]);
  });

  it("is the command the board shows", () => {
    expect(runnerInstallCommand("1.4.2")).toMatch(/^curl -fsSL https:\/\/.+\/v1\.4\.2\/install-runner\.sh \| sh$/);
    expect(runnerInstallCommand("1.4.2", { tailscale: true })).toMatch(/\| sh -s -- --tailscale$/);
    expect(runnerInstallCommand("1.4.2", { tailscale: true, baseUrl: "http://files.test/r" })).toBe(
      "curl -fsSL http://files.test/r/install-runner.sh | sh -s -- --base-url http://files.test/r --tailscale",
    );
    // A URL the shell would split or expand is one quoted word in both places.
    expect(runnerInstallCommand("1.4.2", { baseUrl: "file:///tmp/my release" })).toBe(
      "curl -fsSL 'file:///tmp/my release/install-runner.sh' | sh -s -- --base-url 'file:///tmp/my release'",
    );
  });
});
