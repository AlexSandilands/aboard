import { randomUUID } from "node:crypto";
import { RUNNER_INSTALL_RESULT_PREFIX, RUNNER_INSTALL_STEP_PREFIX } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { SshInstallError, runSshInstall, type SshInstallInput } from "./bootstrap.ts";
import type { SshChild } from "./ssh.ts";

/** An `ssh` that prints `stdout` and `stderr`, then exits with `code`. */
function fakeSsh(script: { stdout?: string; stderr?: string; code?: number | null; error?: string }) {
  const calls: Array<{ args: string[]; stdin: string | undefined }> = [];
  const spawn = (args: string[], stdin?: string): SshChild => {
    calls.push({ args, stdin });
    let out: (text: string) => void = () => {};
    let err: (text: string) => void = () => {};
    return {
      onStdout: (listener) => (out = listener),
      onStderr: (listener) => (err = listener),
      exit: Promise.resolve().then(() => {
        // In two chunks that split a line, as a real pipe may.
        const text = script.stdout ?? "";
        out(text.slice(0, 7));
        out(text.slice(7));
        if (script.stderr) err(script.stderr);
        return { code: script.code === undefined ? 0 : script.code, ...(script.error ? { error: script.error } : {}) };
      }),
      kill: () => {},
    };
  };
  return { spawn, calls };
}

const input: SshInstallInput = { target: "alex@engine", port: 2222, version: "1.4.2", tailscale: true, baseUrl: null };
const pair = { code: "N5PA-RV5M-TS7J", port: 4318, instanceId: randomUUID(), name: "engine", tailscaleIp: "100.1.2.3" };

async function install(script: Parameters<typeof fakeSsh>[0], overrides: Partial<SshInstallInput> = {}) {
  const { spawn, calls } = fakeSsh(script);
  const steps: string[] = [];
  const log: string[] = [];
  const result = await runSshInstall(
    { ...input, ...overrides },
    { onStep: (s) => steps.push(s), onLog: (l) => log.push(l) },
    spawn,
  ).catch((error: unknown) => error);
  return { result, steps, log, call: calls[0]! };
}

describe("the SSH install", () => {
  it("pipes the install script to sh on the target and returns the pairing code it prints", async () => {
    const { result, steps, log, call } = await install({
      stdout:
        `${RUNNER_INSTALL_STEP_PREFIX}download\nDownloading the runner\n${RUNNER_INSTALL_STEP_PREFIX}verify\n` +
        `${RUNNER_INSTALL_STEP_PREFIX}service\nWrote the unit\n${RUNNER_INSTALL_STEP_PREFIX}pair\n` +
        `${RUNNER_INSTALL_RESULT_PREFIX}${JSON.stringify(pair)}\n`,
    });
    expect(result).toEqual(pair);
    expect(steps).toEqual(["download", "verify", "service", "pair"]);
    // The line with the code never reaches the log.
    expect(log).toEqual(["Downloading the runner", "Wrote the unit"]);
    expect(call.stdin).toContain('version="1.4.2"');
    expect(call.args.slice(-5, -1)).toEqual(["-p", "2222", "--", "alex@engine"]);
    expect(call.args).toContain("BatchMode=yes");
  });

  it("quotes what it passes to the remote shell", async () => {
    const { call } = await install({ stdout: "" }, { baseUrl: "file:///tmp/my release; rm -rf ~" });
    expect(call.args.at(-1)).toBe(
      "sh -s -- --porcelain --version 1.4.2 --tailscale --base-url 'file:///tmp/my release; rm -rf ~'",
    );
    expect(call.args.at(-2)).toBe("alex@engine");
    expect(call.args.at(-3)).toBe("--");
  });

  it("says what to do when ssh can't log in or doesn't know the host", async () => {
    const denied = await install({ code: 255, stderr: "alex@engine: Permission denied (publickey,password).\n" });
    expect(denied.result).toBeInstanceOf(SshInstallError);
    expect((denied.result as Error).message).toContain("ssh-copy-id alex@engine");
    const unknown = await install({ code: 255, stderr: "Host key verification failed.\n" });
    expect((unknown.result as Error).message).toContain("Run `ssh alex@engine` once");
    const missing = await install({ code: null, error: "spawn ssh ENOENT" });
    expect((missing.result as Error).message).toContain("Is OpenSSH installed");
  });

  it("reports the script's own last words when it fails, and an install that ends without a code", async () => {
    const failed = await install({
      code: 1,
      stdout: `${RUNNER_INSTALL_STEP_PREFIX}download\n`,
      stderr: "Couldn't download the release. Is there a release 1.4.2 for linux-x64?\n",
    });
    expect((failed.result as Error).message).toBe(
      "Couldn't download the release. Is there a release 1.4.2 for linux-x64?",
    );
    expect(failed.steps).toEqual(["download"]);
    const silent = await install({ stdout: "done\n" });
    expect((silent.result as Error).message).toContain("without a pairing code");
    const garbled = await install({ stdout: `${RUNNER_INSTALL_RESULT_PREFIX}{"code":1}\n` });
    expect((garbled.result as Error).message).toContain("can't read");
  });
});
