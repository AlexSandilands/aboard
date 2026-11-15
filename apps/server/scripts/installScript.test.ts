import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BRAND,
  RUNNER_INSTALL_RESULT_PREFIX,
  SERVER_CHECKSUMS,
  SERVER_LAUNCHER_NAME,
  brandEnv,
  runnerInstallScript,
  serverPlatformOf,
  serverReleaseName,
} from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";

// The install script run for real, against a folder standing in for the release. The "runner" in the tarball is a
// stub that records how it was called, so nothing is installed on the machine running the tests.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VERSION = "9.9.9";
const platform = serverPlatformOf(process.platform, process.arch);

function published(options: { tamper?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-install-`));
  dirs.push(dir);
  const name = serverReleaseName(VERSION, platform!);
  const release = join(dir, "release");
  mkdirSync(join(release, name, "bin"), { recursive: true });
  const bind = brandEnv("BIND");
  writeFileSync(
    join(release, name, "bin", SERVER_LAUNCHER_NAME),
    `#!/bin/sh\necho "$* bind=\${${bind}:-} path=$PATH" >> "$HOME/calls"\nif [ "$1" = pair ]; then echo '{"code":"N5PA"}'; fi\n`,
    { mode: 0o755 },
  );
  spawnSync("tar", ["-czf", join(release, `${name}.tar.gz`), "-C", release, name]);
  rmSync(join(release, name), { recursive: true });
  const sum = createHash("sha256")
    .update(options.tamper ? "other" : readFileSync(join(release, `${name}.tar.gz`)))
    .digest("hex");
  writeFileSync(join(release, SERVER_CHECKSUMS), `${sum}  ${name}.tar.gz\n`);
  const home = join(dir, "home");
  mkdirSync(home);
  const run = (...args: string[]) =>
    spawnSync("sh", ["-s", "--", "--version", VERSION, "--base-url", pathToFileURL(release).href, ...args], {
      input: runnerInstallScript("1.0.0"),
      encoding: "utf8",
      // A login shell that adds to PATH, as the user's own would.
      env: { HOME: home, PATH: process.env.PATH, SHELL: "/bin/sh", ENV: "", XDG_DATA_HOME: "" },
    });
  const root = join(home, ".local", "share", SERVER_LAUNCHER_NAME);
  const calls = () => (existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "");
  return { run, root, home, name, calls };
}

describe.skipIf(platform === null)("install-runner.sh", () => {
  it("downloads, checks and unpacks the release, links it, installs the service and prints a pairing code", () => {
    const { run, root, home, name, calls } = published();
    const out = run("--porcelain", "--tailscale");
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.stdout.split("\n").filter((l) => l.startsWith("@@step"))).toEqual([
      "@@step download",
      "@@step verify",
      "@@step service",
      "@@step pair",
    ]);
    expect(out.stdout).toContain(`${RUNNER_INSTALL_RESULT_PREFIX}{"code":"N5PA"}`);
    expect(readlinkSync(join(root, "current"))).toBe(`releases/${name}`);
    expect(readlinkSync(join(home, ".local", "bin", SERVER_LAUNCHER_NAME))).toBe(
      join(root, "current", "bin", SERVER_LAUNCHER_NAME),
    );
    const [service, pair] = calls().trim().split("\n");
    expect(service).toMatch(/^service install bind=private path=/);
    // With this machine's Tailscale address, when it has one.
    expect(pair).toMatch(/^pair --json --tailscale-ip [\d.]* bind=private/);
  });

  it("installs over what is there without downloading again, and talks to a person without --porcelain", () => {
    const { run, calls } = published();
    expect(run().status).toBe(0);
    const again = run();
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already downloaded");
    expect(again.stdout).toContain("run this script\nagain with --tailscale");
    expect(again.stdout).not.toContain("@@");
    expect(calls().trim().split("\n")).toHaveLength(4);
  });

  it("installs nothing when the download doesn't match its checksum", () => {
    const { run, root, calls } = published({ tamper: true });
    const out = run("--porcelain");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("doesn't match its checksum");
    expect(existsSync(join(root, "current"))).toBe(false);
    expect(calls()).toBe("");
  });

  it("says so when the release has no tarball for the version", () => {
    const { run } = published();
    const out = run("--version", "1.2.3");
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("Is there a release 1.2.3");
  });
});
