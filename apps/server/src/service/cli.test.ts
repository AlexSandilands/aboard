import { BRAND, brandEnv } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { runServiceCommand, type ServiceDeps } from "./cli.ts";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, launchdPlist, systemdUnit } from "./definitions.ts";

const LAUNCHER = `/opt/runner/current/bin/${BRAND.id}-server`;

/** A fake OS: records commands and files, answers commands from `answers`. */
function fakeDeps(
  overrides: Partial<ServiceDeps> & {
    answers?: Record<string, { status?: number; stdout?: string; stderr?: string }>;
  } = {},
) {
  const { answers = {}, ...rest } = overrides;
  const files = new Map<string, string>();
  const commands: string[] = [];
  const lines: string[] = [];
  // The runner answers once the service has been started.
  let started = false;
  const deps: ServiceDeps = {
    platform: "linux",
    env: { PATH: "/usr/bin:/home/u/.local/bin", [brandEnv("PORT")]: "4400", [brandEnv("TOKEN")]: "secret" },
    userHome: "/home/u",
    uid: 501,
    user: "u",
    serverCommand: [LAUNCHER],
    dataDir: `/home/u/.${BRAND.id}`,
    run: (command, args) => {
      const line = [command, ...args].join(" ");
      commands.push(line);
      if (/^systemctl --user restart|^launchctl bootstrap/.test(line)) started = true;
      const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1];
      return { status: answer?.status ?? 0, stdout: answer?.stdout ?? "", stderr: answer?.stderr ?? "" };
    },
    writeFile: (path, contents) => files.set(path, contents),
    mkdir: () => {},
    removeFile: (path) => files.delete(path),
    exists: (path) => files.has(path),
    readFile: (path) => files.get(path) ?? null,
    runnerUrl: async () => (started ? "http://127.0.0.1:4400" : null),
    sleep: async () => {},
    out: (line) => lines.push(line),
    ...rest,
  };
  return { deps, files, commands, lines };
}

const unitPath = `/home/u/.config/systemd/user/${SYSTEMD_UNIT}`;

describe("service definitions", () => {
  const spec = {
    command: ['/opt/my "runner"/bin/x', "--runner"],
    environment: { PATH: "/usr/bin:/a%b" },
    logFile: "/home/u/logs/runner.log",
  };

  it("writes a systemd user unit with quoted words and escaped specifiers", () => {
    const unit = systemdUnit(spec, "/home/u/.config");
    expect(unit.path).toBe(unitPath);
    expect(unit.contents).toContain(`ExecStart="/opt/my \\"runner\\"/bin/x" "--runner"`);
    // systemd expands $ in ExecStart, not in Environment.
    const dollar = systemdUnit({ ...spec, command: ["/opt/$HOME/x"], environment: { A: "$b" } }, "/c");
    expect(dollar.contents).toContain(`ExecStart="/opt/$$HOME/x"`);
    expect(dollar.contents).toContain(`Environment="A=$b"`);
    expect(unit.contents).toContain(`Environment="PATH=/usr/bin:/a%%b"`);
    expect(unit.contents).toContain("WantedBy=default.target");
  });

  it("writes a launchd agent with escaped strings", () => {
    const plist = launchdPlist({ ...spec, command: ["/opt/a&b/x", "--runner"] }, "/Users/u");
    expect(plist.path).toBe(`/Users/u/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(plist.contents).toContain("<string>/opt/a&amp;b/x</string>");
    expect(plist.contents).toContain("<key>RunAtLoad</key>");
    expect(plist.contents).toContain("<string>/home/u/logs/runner.log</string>");
  });
});

describe("service install", () => {
  it("installs a systemd unit that runs the launcher as a runner, turns on linger and waits for it", async () => {
    const { deps, files, commands, lines } = fakeDeps({ answers: { "loginctl show-user": { stdout: "no\n" } } });
    expect(await runServiceCommand(["install"], deps)).toBe(0);
    const unit = files.get(unitPath) ?? "";
    expect(unit).toContain(`ExecStart="${LAUNCHER}" "--runner"`);
    expect(unit).toContain(`Environment="PATH=/usr/bin:/home/u/.local/bin"`);
    expect(unit).toContain(`Environment="${brandEnv("PORT")}=4400"`);
    // A token is never written into the unit.
    expect(unit).not.toContain("secret");
    expect(commands).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable ${SYSTEMD_UNIT}`,
      `systemctl --user restart ${SYSTEMD_UNIT}`,
      "loginctl show-user u --property=Linger --value",
      "loginctl enable-linger u",
    ]);
    expect(lines.at(-1)).toContain("running at http://127.0.0.1:4400");
  });

  it("says how to turn linger on when it can't", async () => {
    const { deps, lines } = fakeDeps({
      answers: {
        "loginctl show-user": { stdout: "no" },
        "loginctl enable-linger": { status: 1, stderr: "Access denied" },
      },
    });
    expect(await runServiceCommand(["install"], deps)).toBe(0);
    expect(lines.join("\n")).toContain("sudo loginctl enable-linger u");
  });

  it("fails with systemctl's message, and when the runner never answers", async () => {
    const failing = fakeDeps({
      answers: { "systemctl --user enable": { status: 1, stderr: "Failed to connect to bus" } },
    });
    expect(await runServiceCommand(["install"], failing.deps)).toBe(1);
    expect(failing.lines.at(-1)).toContain("Failed to connect to bus");
    expect(failing.files.size).toBe(0);
    // Enabled before the failure, so disabled again.
    expect(failing.commands.slice(2)).toEqual([
      `systemctl --user disable ${SYSTEMD_UNIT}`,
      "systemctl --user daemon-reload",
    ]);

    const silent = fakeDeps({ answers: { "loginctl show-user": { stdout: "yes" } }, runnerUrl: async () => null });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => (now += 5000);
    try {
      expect(await runServiceCommand(["install"], silent.deps)).toBe(1);
    } finally {
      Date.now = realNow;
    }
    expect(silent.lines.at(-1)).toContain(`journalctl --user -u ${SYSTEMD_UNIT}`);
  });

  it("puts the previous unit back when a reinstall fails", async () => {
    const { deps, files, commands, lines } = fakeDeps({
      answers: { "systemctl --user restart": { status: 1, stderr: "Job failed" } },
    });
    files.set(unitPath, "the old unit");
    expect(await runServiceCommand(["install"], deps)).toBe(1);
    expect(files.get(unitPath)).toBe("the old unit");
    expect(commands.slice(-2)).toEqual(["systemctl --user daemon-reload", `systemctl --user restart ${SYSTEMD_UNIT}`]);
    expect(lines.at(-1)).toContain("the previous service was put back");
  });

  it("refuses while a runner started by hand holds the port, but reinstalls over the service's own", async () => {
    const byHand = fakeDeps({ runnerUrl: async () => "http://127.0.0.1:4400" });
    expect(await runServiceCommand(["install"], byHand.deps)).toBe(1);
    expect(byHand.files.size).toBe(0);
    expect(byHand.lines.at(-1)).toContain("already running at http://127.0.0.1:4400");

    const service = fakeDeps({
      runnerUrl: async () => "http://127.0.0.1:4400",
      answers: { "systemctl --user is-active": { stdout: "active\n" }, "loginctl show-user": { stdout: "yes" } },
    });
    expect(await runServiceCommand(["install"], service.deps)).toBe(0);
  });

  it("refuses without a command to start, as when run from source", async () => {
    const { deps, files, lines } = fakeDeps({ serverCommand: null });
    expect(await runServiceCommand(["install"], deps)).toBe(1);
    expect(files.size).toBe(0);
    expect(lines.at(-1)).toContain(`bin/${BRAND.id}-server`);
  });

  it("only prints what it would do with --dry-run", async () => {
    const { deps, files, commands, lines } = fakeDeps();
    expect(await runServiceCommand(["install", "--dry-run"], deps)).toBe(0);
    expect(files.size).toBe(0);
    expect(commands).toEqual([]);
    expect(lines.join("\n")).toContain(`ExecStart="${LAUNCHER}" "--runner"`);
  });

  it("bootstraps a launchd agent on macOS", async () => {
    const { deps, files, commands } = fakeDeps({ platform: "darwin", userHome: "/Users/u" });
    expect(await runServiceCommand(["install"], deps)).toBe(0);
    const path = `/Users/u/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    expect(files.get(path)).toContain(`<string>${LAUNCHER}</string>`);
    expect(commands).toEqual([
      "launchctl print gui/501",
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${path}`,
    ]);
  });

  it("explains that a LaunchAgent needs a desktop login when the Mac has none", async () => {
    const { deps, files, lines } = fakeDeps({
      platform: "darwin",
      userHome: "/Users/u",
      answers: { "launchctl print gui/501": { status: 113, stderr: "Could not find domain" } },
    });
    expect(await runServiceCommand(["install"], deps)).toBe(1);
    expect(files.size).toBe(0);
    expect(lines.at(-1)).toContain("no desktop session");
  });

  it("has no service on Windows", async () => {
    const { deps, lines } = fakeDeps({ platform: "win32" });
    expect(await runServiceCommand(["install"], deps)).toBe(1);
    expect(lines[0]).toContain("--runner");
  });
});

describe("service uninstall and status", () => {
  it("stops and removes the unit, keeping linger and the data dir", async () => {
    const { deps, files, commands, lines } = fakeDeps({ answers: { "loginctl show-user": { stdout: "yes" } } });
    files.set(unitPath, "unit");
    expect(await runServiceCommand(["uninstall"], deps)).toBe(0);
    expect(files.has(unitPath)).toBe(false);
    expect(commands.slice(0, 2)).toEqual([
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      "systemctl --user daemon-reload",
    ]);
    expect(lines.join("\n")).toContain("disable-linger");
  });

  it("reports the unit, linger and whether the runner answers", async () => {
    const { deps, files, lines } = fakeDeps({
      runnerUrl: async () => "http://127.0.0.1:4400",
      answers: {
        "systemctl --user is-active": { stdout: "active\n" },
        "systemctl --user is-enabled": { stdout: "enabled\n" },
        "loginctl show-user": { stdout: "yes" },
      },
    });
    expect(await runServiceCommand(["status"], deps)).toBe(1);
    expect(lines[0]).toBe("Service: not installed");
    files.set(unitPath, "unit");
    lines.length = 0;
    expect(await runServiceCommand(["status"], deps)).toBe(0);
    expect(lines).toEqual([
      `Service: ${unitPath}`,
      "systemd: active, enabled",
      "Linger: on",
      "Runner: answering at http://127.0.0.1:4400",
    ]);
  });

  it("rejects unknown commands and flags", async () => {
    expect(await runServiceCommand([], fakeDeps().deps)).toBe(2);
    expect(await runServiceCommand(["restart"], fakeDeps().deps)).toBe(2);
    expect(await runServiceCommand(["status", "--dry-run"], fakeDeps().deps)).toBe(2);
  });
});
