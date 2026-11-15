import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
// POSIX paths whatever the host: services exist only on Linux and macOS, and tests run on Windows too.
import { dirname, join } from "node:path/posix";
import { BRAND, DEFAULT_RUNNER_PORT, brandEnv } from "@repo/contracts";
import { defaultHomeDir } from "../config.ts";
import { runningServer } from "../serverFile.ts";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  launchdPlist,
  systemdUnit,
  type ServiceFile,
  type ServiceSpec,
} from "./definitions.ts";

// `<id>-server service install | uninstall | status`: runs the runner as a background service of the user's, so it
// outlives the SSH session or terminal that started it (docs/features/remote-machines.md#the-service).

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Everything the commands touch outside this file, so tests can fake the OS. */
export interface ServiceDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  userHome: string;
  uid: number;
  user: string;
  /** How to start this server again: the release's launcher, or Node on the bundle. Null when run from source. */
  serverCommand: string[] | null;
  /** The runner's data dir, where it records the URL it listens on. */
  dataDir: string;
  run(command: string, args: string[]): CommandResult;
  /** Writes a file, making its folder. */
  writeFile(path: string, contents: string): void;
  mkdir(path: string): void;
  removeFile(path: string): void;
  exists(path: string): boolean;
  /** A file's contents, or null when it doesn't exist. */
  readFile(path: string): string | null;
  /** The URL of the runner answering on the data dir, or null (none, or a board there). */
  runnerUrl(): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
}

const READY_TIMEOUT_MS = 20_000;

/** The variables the service keeps from the shell that installed it. */
const KEPT_ENV = ["PATH", brandEnv("HOME"), brandEnv("PORT"), brandEnv("BIND")];

function spec(deps: ServiceDeps, command: string[]): ServiceSpec {
  const environment: Record<string, string> = {};
  for (const key of KEPT_ENV) {
    const value = deps.env[key];
    if (value) environment[key] = value;
  }
  return { command: [...command, "--runner"], environment, logFile: join(deps.dataDir, "logs", "runner.log") };
}

function serviceFile(deps: ServiceDeps, command: string[]): ServiceFile {
  const s = spec(deps, command);
  if (deps.platform === "darwin") return launchdPlist(s, deps.userHome);
  return systemdUnit(s, deps.env.XDG_CONFIG_HOME || join(deps.userHome, ".config"));
}

/** The service file's path, which doesn't depend on the command. */
const servicePath = (deps: ServiceDeps) => serviceFile(deps, []).path;

const supported = (platform: NodeJS.Platform) => platform === "linux" || platform === "darwin";

const where = (deps: ServiceDeps) =>
  deps.platform === "darwin"
    ? `the log is ${join(deps.dataDir, "logs", "runner.log")}`
    : `see its log with \`journalctl --user -u ${SYSTEMD_UNIT}\``;

class ServiceError extends Error {}

function must(deps: ServiceDeps, command: string, args: string[]): string {
  const result = deps.run(command, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new ServiceError(`\`${command} ${args.join(" ")}\` failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

/** Whether systemd keeps this user's services running while they are logged out. */
function lingering(deps: ServiceDeps): boolean {
  return deps.run("loginctl", ["show-user", deps.user, "--property=Linger", "--value"]).stdout.trim() === "yes";
}

const launchdTarget = (deps: ServiceDeps) => `gui/${deps.uid}`;

/**
 * Unloads the agent and waits for launchd to let go of it: `bootout` returns while the old one may still be
 * stopping, and a `bootstrap` meanwhile fails.
 */
async function bootOut(deps: ServiceDeps): Promise<void> {
  const target = `${launchdTarget(deps)}/${LAUNCHD_LABEL}`;
  deps.run("launchctl", ["bootout", target]);
  for (let i = 0; i < 20 && deps.run("launchctl", ["print", target]).status === 0; i++) await deps.sleep(250);
}

/** Whether the service itself is running, as opposed to a runner someone started by hand. */
function serviceRunning(deps: ServiceDeps): boolean {
  if (deps.platform === "darwin") {
    return deps.run("launchctl", ["print", `${launchdTarget(deps)}/${LAUNCHD_LABEL}`]).status === 0;
  }
  return deps.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim() === "active";
}

/**
 * Puts things back after a failed install: the service file that was there before (with its service started
 * again), or none. Best effort: the error that got us here is what gets reported.
 */
function rollBack(deps: ServiceDeps, path: string, previous: string | null): "removed" | "restored" | "not restarted" {
  if (deps.platform === "darwin") {
    if (previous === null) {
      deps.removeFile(path);
      return "removed";
    }
    deps.writeFile(path, previous);
    return deps.run("launchctl", ["bootstrap", launchdTarget(deps), path]).status === 0 ? "restored" : "not restarted";
  }
  if (previous === null) {
    deps.run("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
    deps.removeFile(path);
    deps.run("systemctl", ["--user", "daemon-reload"]);
    return "removed";
  }
  deps.writeFile(path, previous);
  deps.run("systemctl", ["--user", "daemon-reload"]);
  return deps.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]).status === 0 ? "restored" : "not restarted";
}

async function install(deps: ServiceDeps, dryRun: boolean): Promise<number> {
  if (!deps.serverCommand) {
    throw new ServiceError(
      `run \`service install\` from the release's bin/${BRAND.id}-server, so the service has a command to start`,
    );
  }
  const file = serviceFile(deps, deps.serverCommand);
  const commands: Array<[string, string[]]> =
    deps.platform === "darwin"
      ? [["launchctl", ["bootstrap", launchdTarget(deps), file.path]]]
      : [
          ["systemctl", ["--user", "daemon-reload"]],
          ["systemctl", ["--user", "enable", SYSTEMD_UNIT]],
          // restart rather than start, so a reinstall runs the new command.
          ["systemctl", ["--user", "restart", SYSTEMD_UNIT]],
        ];
  if (dryRun) {
    deps.out(`Would write ${file.path}:\n\n${file.contents}`);
    for (const [command, args] of commands) deps.out(`Would run: ${command} ${args.join(" ")}`);
    if (deps.platform === "linux") deps.out(`Would run: loginctl enable-linger ${deps.user} (if linger is off)`);
    return 0;
  }

  // A LaunchAgent lives in the user's desktop session, which an SSH login alone doesn't have.
  if (deps.platform === "darwin" && deps.run("launchctl", ["print", launchdTarget(deps)]).status !== 0) {
    throw new ServiceError(
      `${deps.user} has no desktop session on this Mac, and the runner's LaunchAgent runs only in one. Log in at ` +
        "the Mac (or turn on automatic login), then install again.",
    );
  }
  // One started by hand would hold the port, and the service would fail to start behind it while the wait below
  // found the other one answering.
  const running = await deps.runnerUrl();
  if (running && !serviceRunning(deps)) {
    throw new ServiceError(`A runner is already running at ${running}, not as the service. Stop it, then install.`);
  }

  const previous = deps.readFile(file.path);
  deps.writeFile(file.path, file.contents);
  deps.out(`Wrote ${file.path}`);
  // Both come from this shell's variables; a reinstall without them goes back to the defaults.
  deps.out(`Data dir ${deps.dataDir}, port ${deps.env[brandEnv("PORT")] ?? DEFAULT_RUNNER_PORT}`);
  // launchd opens the log before the runner starts, and doesn't make its folder.
  if (deps.platform === "darwin") deps.mkdir(join(deps.dataDir, "logs"));
  // A loaded agent must be booted out before it can be bootstrapped again; not loaded is fine.
  if (deps.platform === "darwin") await bootOut(deps);
  try {
    for (const [command, args] of commands) must(deps, command, args);
  } catch (error) {
    // Not left half set up, and a reinstall that failed leaves the service that worked before.
    const rolledBack = rollBack(deps, file.path, previous);
    if (error instanceof ServiceError && rolledBack !== "removed") {
      error.message +=
        rolledBack === "restored"
          ? "; the previous service was put back"
          : "; the previous service file was put back, but it didn't start again";
    }
    throw error;
  }

  if (deps.platform === "linux" && !lingering(deps)) {
    const linger = deps.run("loginctl", ["enable-linger", deps.user]);
    if (linger.status === 0) deps.out("Turned on linger, so the runner keeps running after you log out.");
    else {
      deps.out(
        `Linger is off and couldn't be turned on (${(linger.stderr || "no permission").trim()}), so the runner stops ` +
          `when you log out. An admin can turn it on: sudo loginctl enable-linger ${deps.user}`,
      );
    }
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const url = await deps.runnerUrl();
    if (url) {
      deps.out(`The ${BRAND.name} runner is running at ${url}.`);
      return 0;
    }
    if (Date.now() > deadline) break;
    await deps.sleep(500);
  }
  deps.out(`The service is installed but the runner isn't answering yet; ${where(deps)}.`);
  return 1;
}

function uninstall(deps: ServiceDeps): number {
  const path = servicePath(deps);
  if (!deps.exists(path)) {
    deps.out("The runner service isn't installed.");
    return 0;
  }
  if (deps.platform === "darwin") {
    deps.run("launchctl", ["bootout", `${launchdTarget(deps)}/${LAUNCHD_LABEL}`]);
    deps.removeFile(path);
  } else {
    // Fails when the unit is already gone from systemd; the file is removed either way.
    deps.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    deps.removeFile(path);
    must(deps, "systemctl", ["--user", "daemon-reload"]);
  }
  deps.out(`Stopped the runner and removed ${path}. Its data dir, ${deps.dataDir}, is kept.`);
  if (deps.platform === "linux" && lingering(deps)) {
    deps.out(`Linger stays on, as other services may need it: sudo loginctl disable-linger ${deps.user} turns it off.`);
  }
  return 0;
}

async function status(deps: ServiceDeps): Promise<number> {
  const path = servicePath(deps);
  const installed = deps.exists(path);
  deps.out(`Service: ${installed ? path : "not installed"}`);
  if (installed && deps.platform === "darwin") {
    const print = deps.run("launchctl", ["print", `${launchdTarget(deps)}/${LAUNCHD_LABEL}`]);
    const state = /^\s*state = (.+)$/m.exec(print.stdout)?.[1];
    deps.out(`launchd: ${print.status === 0 ? (state ?? "loaded") : "not loaded"}`);
  } else if (installed) {
    const active = deps.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]).stdout.trim() || "unknown";
    const enabled = deps.run("systemctl", ["--user", "is-enabled", SYSTEMD_UNIT]).stdout.trim() || "unknown";
    deps.out(`systemd: ${active}, ${enabled}`);
    deps.out(`Linger: ${lingering(deps) ? "on" : "off (the runner stops when you log out)"}`);
  }
  const url = await deps.runnerUrl();
  deps.out(`Runner: ${url ? `answering at ${url}` : "not answering"}`);
  if (installed && !url) deps.out(`The service is installed but the runner isn't answering; ${where(deps)}.`);
  return installed && url ? 0 : 1;
}

export async function runServiceCommand(args: string[], deps: ServiceDeps = defaultDeps()): Promise<number> {
  const [command, ...flags] = args;
  const dryRun = flags.includes("--dry-run");
  const unknown = flags.find((flag) => flag !== "--dry-run" || command !== "install");
  if (!command || !["install", "uninstall", "status"].includes(command) || unknown !== undefined) {
    deps.out(`Usage: ${BRAND.id}-server service install [--dry-run] | uninstall | status`);
    return 2;
  }
  if (!supported(deps.platform)) {
    deps.out(
      `There's no background service on ${deps.platform}; run \`${BRAND.id}-server --runner\` yourself instead.`,
    );
    return 1;
  }
  try {
    if (command === "install") return await install(deps, dryRun);
    if (command === "uninstall") return uninstall(deps);
    return await status(deps);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    deps.out(error.message);
    return 1;
  }
}

/** The command that started this process, so the service can start it again. */
function currentServerCommand(env: NodeJS.ProcessEnv): string[] | null {
  // The release's launcher passes its own path, which stays put when the release behind a symlink changes.
  const launcher = env[brandEnv("LAUNCHER")];
  if (launcher) return [launcher];
  const script = process.argv[1];
  // From source (tsx), the entry is a .ts file plain Node can't run.
  return script?.endsWith(".mjs") ? [process.execPath, script] : null;
}

function defaultDeps(): ServiceDeps {
  const env = process.env;
  // Not loadConfig, which makes the folder: `status` or a dry run shouldn't leave one behind.
  const dataDir = env[brandEnv("HOME")] ?? defaultHomeDir("runner");
  return {
    platform: process.platform,
    env,
    userHome: homedir(),
    uid: process.getuid?.() ?? 0,
    user: userInfo().username,
    serverCommand: currentServerCommand(env),
    dataDir,
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        status: result.error ? null : result.status,
        stdout: result.stdout ?? "",
        stderr: result.error?.message ?? result.stderr ?? "",
      };
    },
    writeFile: (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    removeFile: (path) => rmSync(path, { force: true }),
    exists: existsSync,
    readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    runnerUrl: async () => {
      const running = await runningServer(dataDir);
      return running?.health.role === "runner" ? running.url : null;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (line) => console.log(line),
  };
}
