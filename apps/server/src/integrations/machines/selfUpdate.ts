import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRAND,
  SERVER_CHECKSUMS,
  SERVER_LAUNCHER_NAME,
  brandEnv,
  serverPlatformOf,
  serverReleaseBaseUrl,
  serverReleaseName,
  type MachineUpdateState,
  type UpdateMachineRequest,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import { messageOf, type Logger } from "../util.ts";

// A runner updating itself when its board asks (docs/features/remote-machines.md#updates). It never does so by
// itself. The new release is unpacked beside the running one, `current` is pointed at it, and the process exits so
// the service starts it; a failure at any point before that leaves the running version as it is.

/** The exit code that asks the service to start the runner again: non-zero, so both systemd and launchd restart it. */
export const RESTART_EXIT_CODE = 75;

/** How often a waiting update looks whether the runs have ended. */
const WAIT_POLL_MS = 15_000;
/** Long enough for the answer to the update request to leave before the process does. */
const RESTART_DELAY_MS = 500;

export interface SelfUpdateDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  /** Agent runs going on now. */
  runsInFlight(): number;
  /** Stops the server so the service starts the new release. */
  restart(): void;
  /** Runs a program to its end; rejects when it fails. Returns its stdout. */
  exec?: (exe: string, args: string[]) => Promise<string>;
  log?: Logger;
}

export interface SelfUpdater {
  /** Whether this runner can update itself: installed by the install script and run by its service. */
  available(): boolean;
  state(): MachineUpdateState;
  /**
   * Updates to `version`: at once when nothing runs or `now` is set, else when the runs have ended. Asking again
   * for the version already asked for changes nothing but `now`. Throws CONFLICT when the runner can't update itself.
   */
  request(input: UpdateMachineRequest): MachineUpdateState;
  /** Stops waiting. */
  stop(): void;
}

const execFile = (exe: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${basename(exe)} exited with ${code}`));
    });
  });

/**
 * Where the install script put this runner: `<root>/releases/<release>/bin/<launcher>`, run through `<root>/current`.
 * Null for a runner unpacked by hand, which has no `current` to repoint.
 */
function installRoot(launcher: string | undefined): string | null {
  if (!launcher) return null;
  try {
    const releases = dirname(dirname(dirname(realpathSync(launcher))));
    const root = dirname(releases);
    if (basename(releases) !== "releases") return null;
    return lstatSync(join(root, "current")).isSymbolicLink() ? root : null;
  } catch {
    return null;
  }
}

export function createSelfUpdater(deps: SelfUpdateDeps): SelfUpdater {
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetch ?? fetch;
  const exec = deps.exec ?? execFile;
  const log = deps.log ?? console;
  const root = installRoot(env[brandEnv("LAUNCHER")]);
  const platform = serverPlatformOf(deps.platform ?? process.platform, deps.arch ?? process.arch);
  // The marker `service install` puts in the service: without a service, exiting would just stop the runner.
  const available = root !== null && platform !== null && env[brandEnv("SERVICE")] === "1";

  let current: MachineUpdateState = { state: "idle", targetVersion: null, error: null };
  let waiting: NodeJS.Timeout | null = null;

  const stopWaiting = () => {
    if (waiting) clearInterval(waiting);
    waiting = null;
  };

  async function download(url: string): Promise<Buffer> {
    // A folder of release files, for trying an update without publishing one.
    if (url.startsWith("file:")) return readFileSync(fileURLToPath(url));
    const res = await fetchFn(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function install(version: string): Promise<void> {
    if (!root || !platform) throw new Error("This runner can't update itself");
    const name = serverReleaseName(version, platform);
    const releases = join(root, "releases");
    const dest = join(releases, name);
    const launcher = join(dest, "bin", SERVER_LAUNCHER_NAME);
    if (!existsSync(launcher)) {
      const base = env[brandEnv("RELEASE_URL")] || serverReleaseBaseUrl(version);
      if (!base) throw new Error("There is nowhere to download releases from");
      const sums = (await download(`${base}/${SERVER_CHECKSUMS}`)).toString("utf8");
      const expected = sums
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .find(([, file]) => file === `${name}.tar.gz`)?.[0];
      if (!expected) throw new Error(`The release's checksums don't list ${name}.tar.gz`);
      const tarball = await download(`${base}/${name}.tar.gz`);
      const actual = createHash("sha256").update(tarball).digest("hex");
      if (actual !== expected.toLowerCase()) {
        throw new Error(`The download doesn't match its checksum (${actual}, not ${expected})`);
      }
      const tmp = join(releases, `.download.${randomUUID()}`);
      mkdirSync(tmp, { recursive: true });
      try {
        writeFileSync(join(tmp, `${name}.tar.gz`), tarball);
        await exec("tar", ["-xzf", join(tmp, `${name}.tar.gz`), "-C", tmp]);
        rmSync(dest, { recursive: true, force: true });
        renameSync(join(tmp, name), dest);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    // Run once before anything points at it: a release that can't start here is found now, not by the service.
    const reported = (await exec(launcher, ["--version"])).trim();
    if (reported !== version) throw new Error(`The release says it is version ${reported || "?"}, not ${version}`);

    // Made beside `current` and moved over it, so there is never a moment without one.
    const next = join(root, `current.${randomUUID()}`);
    symlinkSync(join("releases", name), next);
    renameSync(next, join(root, "current"));

    // The release left behind (the one running now) stays, to go back to by hand; older ones go.
    const keep = new Set([name, serverReleaseName(BRAND.version, platform)]);
    for (const entry of readdirSync(releases)) {
      if (!keep.has(entry)) rmSync(join(releases, entry), { recursive: true, force: true });
    }
  }

  async function run(version: string): Promise<void> {
    try {
      await install(version);
    } catch (error) {
      log.warn(`[update] ${BRAND.version} → ${version} failed: ${messageOf(error)}`);
      current = { state: "failed", targetVersion: version, error: messageOf(error) };
      return;
    }
    current = { state: "restarting", targetVersion: version, error: null };
    log.warn(`[update] ${BRAND.version} → ${version}: restarting`);
    setTimeout(() => deps.restart(), RESTART_DELAY_MS);
  }

  function start(version: string): void {
    stopWaiting();
    current = { state: "downloading", targetVersion: version, error: null };
    void run(version);
  }

  return {
    available: () => available,
    state: () => current,
    request({ version, now }) {
      if (version === BRAND.version) {
        stopWaiting();
        current = { state: "idle", targetVersion: null, error: null };
        return current;
      }
      if (!available) {
        throw new AppError(
          "CONFLICT",
          "This runner wasn't installed by the install script, or isn't running as its service, so it can't update " +
            "itself. Run the install script on the machine again.",
        );
      }
      const same = current.targetVersion === version;
      if (same && (current.state === "downloading" || current.state === "restarting")) return current;
      if (now || deps.runsInFlight() === 0) {
        start(version);
        return current;
      }
      if (same && current.state === "waiting") return current;
      stopWaiting();
      current = { state: "waiting", targetVersion: version, error: null };
      waiting = setInterval(() => {
        if (deps.runsInFlight() === 0) start(version);
      }, WAIT_POLL_MS);
      waiting.unref();
      return current;
    },
    stop: stopWaiting,
  };
}
