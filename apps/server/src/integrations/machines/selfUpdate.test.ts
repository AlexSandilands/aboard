import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, SERVER_CHECKSUMS, SERVER_LAUNCHER_NAME, brandEnv, serverReleaseName } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../errors.ts";
import { createSelfUpdater, type SelfUpdater } from "./selfUpdate.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NEXT = "9.9.9";
const quiet = { warn: () => {} };

/** A release folder whose launcher prints `says` for `--version`. */
function release(parent: string, version: string, says = version): string {
  const name = serverReleaseName(version, "linux-x64");
  mkdirSync(join(parent, name, "bin"), { recursive: true });
  writeFileSync(join(parent, name, "bin", SERVER_LAUNCHER_NAME), `#!/bin/sh\necho ${says}\n`, { mode: 0o755 });
  return name;
}

/** A runner as the install script leaves it, on the running version, and a release server holding `NEXT`. */
function installed(options: { says?: string; tamper?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-update-`));
  dirs.push(dir);
  const root = join(dir, "share");
  const running = release(join(root, "releases"), BRAND.version);
  symlinkSync(join("releases", running), join(root, "current"));
  mkdirSync(join(dir, "bin"));
  const launcher = join(dir, "bin", SERVER_LAUNCHER_NAME);
  symlinkSync(join(root, "current", "bin", SERVER_LAUNCHER_NAME), launcher);

  const published = join(dir, "published");
  const name = release(published, NEXT, options.says ?? NEXT);
  spawnSync("tar", ["-czf", join(published, `${name}.tar.gz`), "-C", published, name]);
  const tarball = readFileSync(join(published, `${name}.tar.gz`));
  const sum = createHash("sha256")
    .update(options.tamper ? "something else" : tarball)
    .digest("hex");
  const files: Record<string, Buffer> = {
    [`${name}.tar.gz`]: tarball,
    [SERVER_CHECKSUMS]: Buffer.from(`${sum}  ${name}.tar.gz\n`),
  };
  const asked: string[] = [];
  const fetchFn = ((input: string) => {
    asked.push(input);
    const body = files[input.split("/").pop() ?? ""];
    return Promise.resolve(body ? new Response(new Uint8Array(body)) : new Response("no", { status: 404 }));
  }) as typeof fetch;

  let runs = 0;
  const restart = vi.fn<() => void>();
  const updater = createSelfUpdater({
    env: { [brandEnv("LAUNCHER")]: launcher, [brandEnv("SERVICE")]: "1", PATH: process.env.PATH },
    platform: "linux",
    arch: "x64",
    fetch: fetchFn,
    runsInFlight: () => runs,
    restart,
    log: quiet,
  });
  return {
    root,
    updater,
    restart,
    asked,
    name,
    running,
    setRuns: (n: number) => {
      runs = n;
    },
  };
}

const settled = async (updater: SelfUpdater) => {
  await vi.waitFor(() => expect(["restarting", "failed"]).toContain(updater.state().state), { timeout: 5000 });
  return updater.state();
};

// The release layout is symlinks and a POSIX launcher; there is no Windows runner.
describe.skipIf(process.platform === "win32")("a runner updating itself", () => {
  it("downloads the release, checks it, repoints current and asks to be restarted", async () => {
    const { root, updater, restart, asked, name, running } = installed();
    expect(updater.available()).toBe(true);
    expect(updater.request({ version: NEXT, now: false })).toMatchObject({ state: "downloading", targetVersion: NEXT });
    expect(await settled(updater)).toMatchObject({ state: "restarting", error: null });
    expect(readlinkSync(join(root, "current"))).toBe(join("releases", name));
    // The release it came from stays, to go back to.
    expect(readdirSync(join(root, "releases")).toSorted()).toEqual([name, running].toSorted());
    expect(asked.every((url) => url.includes(`/releases/download/v${NEXT}/`))).toBe(true);
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  });

  it("keeps the running version when the download doesn't match its checksum", async () => {
    const { root, updater, restart, running } = installed({ tamper: true });
    updater.request({ version: NEXT, now: false });
    const state = await settled(updater);
    expect(state).toMatchObject({ state: "failed", targetVersion: NEXT });
    expect(state.error).toContain("checksum");
    expect(readlinkSync(join(root, "current"))).toBe(join("releases", running));
    expect(readdirSync(join(root, "releases"))).toEqual([running]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("keeps the running version when the new release doesn't start as the version asked for", async () => {
    const { root, updater, running } = installed({ says: "1.0.0" });
    updater.request({ version: NEXT, now: false });
    expect((await settled(updater)).error).toContain("version 1.0.0");
    expect(readlinkSync(join(root, "current"))).toBe(join("releases", running));
  });

  it("waits for runs in flight to end, unless told to update now", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = installed();
    first.setRuns(2);
    expect(first.updater.request({ version: NEXT, now: false })).toMatchObject({ state: "waiting" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.updater.state().state).toBe("waiting");
    first.setRuns(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.updater.state().state).not.toBe("waiting");
    vi.useRealTimers();
    expect((await settled(first.updater)).state).toBe("restarting");

    const second = installed();
    second.setRuns(2);
    second.updater.request({ version: NEXT, now: false });
    expect(second.updater.request({ version: NEXT, now: true }).state).toBe("downloading");
    expect((await settled(second.updater)).state).toBe("restarting");
  });

  it("has nothing to do for the version it runs, and refuses when it wasn't installed by the script", () => {
    const { updater } = installed();
    expect(updater.request({ version: BRAND.version, now: false })).toMatchObject({ state: "idle" });
    const byHand = createSelfUpdater({ env: {}, runsInFlight: () => 0, restart: () => {}, log: quiet });
    expect(byHand.available()).toBe(false);
    expect(() => byHand.request({ version: NEXT, now: true })).toThrow(AppError);
  });
});
