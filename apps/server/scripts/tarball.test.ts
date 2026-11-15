import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, brandEnv } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCHER_NAME, launcherScript, serverReleaseName } from "./tarball.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server tarball", () => {
  it("names the release folder after the brand, version and platform", () => {
    expect(serverReleaseName("1.4.2", "linux-arm64")).toBe(`${BRAND.id}-server-1.4.2-linux-arm64`);
  });

  // The launcher is a POSIX shell script; there's no Windows release.
  it.skipIf(process.platform === "win32")(
    "runs lib/node on lib/server.mjs through a symlink, passing its own path and the arguments",
    () => {
      const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-launcher-`));
      dirs.push(dir);
      const release = join(dir, "release");
      mkdirSync(join(release, "bin"), { recursive: true });
      mkdirSync(join(release, "lib"));
      writeFileSync(join(release, "bin", LAUNCHER_NAME), launcherScript(), { mode: 0o755 });
      // A stand-in Node that prints what it was given.
      const env = brandEnv("LAUNCHER");
      writeFileSync(join(release, "lib", "node"), `#!/bin/sh\necho "$1|$2|$\{${env}}|$NODE_NO_WARNINGS"\n`, {
        mode: 0o755,
      });
      mkdirSync(join(dir, "bin"));
      const link = join(dir, "bin", LAUNCHER_NAME);
      symlinkSync(join(release, "bin", LAUNCHER_NAME), link);

      const out = spawnSync(link, ["--runner"], { encoding: "utf8", env: { PATH: process.env.PATH } });
      expect(out.status).toBe(0);
      const [script, arg, launcher, warnings] = out.stdout.trim().split("|");
      expect(script).toMatch(/release\/lib\/server\.mjs$/);
      expect(arg).toBe("--runner");
      // The symlink, not the file behind it: a service keeps the stable path.
      expect(launcher).toBe(link);
      expect(warnings).toBe("1");
    },
  );
});
