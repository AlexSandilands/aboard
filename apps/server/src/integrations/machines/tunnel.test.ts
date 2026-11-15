import type { SshMachineRoute } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { SshChild } from "./ssh.ts";
import { createRouteOpener } from "./tunnel.ts";

const route: SshMachineRoute = { kind: "ssh", target: "alex@engine", port: 2222, remotePort: 4318 };

/** An `ssh` the test ends itself, with what it was started with and whether it was killed. */
function fakeSsh() {
  const seen: { args: string[]; killed: number } = { args: [], killed: 0 };
  let err: (text: string) => void = () => {};
  let end: (result: { code: number | null; error?: string }) => void = () => {};
  const spawn = (args: string[]): SshChild => {
    seen.args = args;
    return {
      onStdout: () => {},
      onStderr: (listener) => (err = listener),
      exit: new Promise((resolve) => (end = resolve)),
      kill: () => {
        seen.killed += 1;
        end({ code: null });
      },
    };
  };
  return { spawn, seen, say: (text: string) => err(text), exit: (code: number) => end({ code }) };
}

describe("an SSH tunnel", () => {
  it("forwards a free loopback port to the runner's, and ends when its ssh does", async () => {
    const ssh = fakeSsh();
    const open = createRouteOpener({
      spawn: ssh.spawn,
      freePort: () => Promise.resolve(45_001),
      portOpen: () => Promise.resolve(true),
    });
    const handle = await open(route);
    expect(handle.url).toBe("http://127.0.0.1:45001");
    expect(ssh.seen.args).toEqual(
      expect.arrayContaining([
        "-N",
        "-L",
        "127.0.0.1:45001:127.0.0.1:4318",
        "ExitOnForwardFailure=yes",
        "BatchMode=yes",
      ]),
    );
    expect(ssh.seen.args.slice(-4)).toEqual(["-p", "2222", "--", "alex@engine"]);
    let ended = false;
    void handle.ended.then(() => (ended = true));
    handle.close();
    await handle.ended;
    expect(ended).toBe(true);
    expect(ssh.seen.killed).toBe(1);
  });

  it("fails with what ssh said when it exits before forwarding", async () => {
    const ssh = fakeSsh();
    let polls = 0;
    const open = createRouteOpener({
      spawn: ssh.spawn,
      freePort: () => Promise.resolve(45_002),
      // Never listening; ssh gives up on the second look.
      portOpen: () => {
        polls += 1;
        if (polls === 2) {
          ssh.say("alex@engine: Permission denied (publickey).\n");
          ssh.exit(255);
        }
        return Promise.resolve(false);
      },
      sleep: () => Promise.resolve(),
    });
    await expect(open(route)).rejects.toThrow(/ssh-copy-id alex@engine/);
  });

  it("is a direct route's own URL, with nothing to end", async () => {
    const handle = await createRouteOpener()({ kind: "direct", url: "http://100.101.102.103:4318" });
    expect(handle.url).toBe("http://100.101.102.103:4318");
    handle.close();
  });
});
