import type { DirectMachineRoute, MachineRoute, SshMachineRoute } from "@repo/contracts";
import { freeLoopbackPort, loopbackPortOpen, spawnSsh, sshArgs, sshFailure, type SpawnSsh } from "./ssh.ts";

// Opening one route to a machine (docs/features/remote-machines.md#routes): an SSH tunnel to the runner's loopback
// port, or its own address. Which route is used, and when to try another, is link.ts.

/** An open route: the URL the runner answers at through it. */
export interface RouteHandle {
  url: string;
  close(): void;
  /** Resolves when the route ended by itself (the tunnel's ssh exited). Never, for a route with nothing to end. */
  ended: Promise<void>;
}

export type OpenRoute = (route: MachineRoute) => Promise<RouteHandle>;

export interface TunnelDeps {
  spawn?: SpawnSsh;
  freePort?: () => Promise<number>;
  portOpen?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

/** How long ssh gets to log in and start forwarding. */
const TUNNEL_READY_TIMEOUT_MS = 30_000;
const TUNNEL_POLL_MS = 150;
const STDERR_TAIL = 4_000;

/**
 * `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<runner port>`: the runner stays on its own loopback and the board
 * reaches it at a loopback port here. Resolves once ssh is forwarding; rejects with what ssh said when it can't.
 */
async function openSshTunnel(route: SshMachineRoute, deps: TunnelDeps): Promise<RouteHandle> {
  const spawn = deps.spawn ?? spawnSsh;
  const portOpen = deps.portOpen ?? loopbackPortOpen;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const localPort = await (deps.freePort ?? freeLoopbackPort)();
  const child = spawn(
    sshArgs(route, [
      "-N",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${route.remotePort}`,
      // ssh exits when it can't forward (the local port was taken meanwhile), rather than staying up useless.
      "-o",
      "ExitOnForwardFailure=yes",
    ]),
  );
  let stderr = "";
  child.onStderr((text) => {
    stderr = (stderr + text).slice(-STDERR_TAIL);
  });
  // Held in an object: it is set from a callback, which a plain `let` read in the loop below would hide from the compiler.
  const ssh: { exited: { code: number | null; error?: string } | null } = { exited: null };
  const ended = (async () => {
    ssh.exited = await child.exit;
  })();

  const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS;
  for (;;) {
    if (ssh.exited) throw new Error(sshFailure(route.target, stderr, ssh.exited.error));
    if (await portOpen(localPort)) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`ssh ${route.target} didn't start forwarding within ${TUNNEL_READY_TIMEOUT_MS / 1000} seconds`);
    }
    await sleep(TUNNEL_POLL_MS);
  }
  return { url: `http://127.0.0.1:${localPort}`, close: () => child.kill(), ended };
}

const openDirect = (route: DirectMachineRoute): RouteHandle => ({
  url: route.url,
  close: () => {},
  ended: new Promise<void>(() => {}),
});

export function createRouteOpener(deps: TunnelDeps = {}): OpenRoute {
  return (route) => (route.kind === "ssh" ? openSshTunnel(route, deps) : Promise.resolve(openDirect(route)));
}
