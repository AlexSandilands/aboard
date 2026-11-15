import { BRAND } from "@repo/contracts";
import { loadConfig, type Config } from "./config.ts";
import { createContext } from "./context.ts";
import { PAIRING_CODE_TTL_MS, type MachineAuthService } from "./services/machineAuth.ts";

// `<id>-server pair | pair list | pair revoke`: pairing a runner with a board, done on the runner itself
// (docs/features/remote-machines.md#pairing). These read and write the runner's database directly, so making a code
// takes a login on the machine: no request, over a tunnel or the network, can make one.

export const PAIR_USAGE = `Usage:
  ${BRAND.id}-server pair                  print a one-time code to pair this machine with a board
  ${BRAND.id}-server pair list             the board this machine is paired with
  ${BRAND.id}-server pair revoke <id>      unpair: that board's token stops working at once
  ${BRAND.id}-server pair revoke --all     unpair every board and cancel any code not yet used`;

interface PairDeps {
  auth: MachineAuthService;
  machineName: string;
  out: (line: string) => void;
}

function run(args: string[], { auth, machineName, out }: PairDeps): number {
  const [command, ...rest] = args;
  if (command === undefined) {
    const { code } = auth.createPairingCode();
    const [paired] = auth.pairings();
    out(`Pairing code for ${machineName}: ${code}`);
    out(`It works once, within ${PAIRING_CODE_TTL_MS / 60_000} minutes, and replaces any earlier code.`);
    if (paired) {
      out(
        `This machine is paired with ${paired.board.name}; only that board can use the code. ` +
          `To pair another, first run \`${BRAND.id}-server pair revoke ${paired.tokenId}\`.`,
      );
    }
    return 0;
  }
  if (command === "list" && rest.length === 0) {
    const pairings = auth.pairings();
    if (pairings.length === 0) out("Not paired with a board.");
    for (const p of pairings) {
      out(
        `${p.tokenId}  ${p.board.name}  (board ${p.board.instanceId})  paired ${p.pairedAt}, ` +
          `last used ${p.lastUsedAt ?? "never"}`,
      );
    }
    return 0;
  }
  if (command === "revoke" && rest.length === 1 && rest[0] === "--all") {
    out(`Unpaired ${auth.revokeAll()} board(s).`);
    return 0;
  }
  if (command === "revoke" && rest.length === 1 && rest[0]) {
    if (!auth.revoke(rest[0])) {
      out(`No pairing ${rest[0]}; \`${BRAND.id}-server pair list\` shows them.`);
      return 1;
    }
    out(`Unpaired ${rest[0]}.`);
    return 0;
  }
  out(PAIR_USAGE);
  return 2;
}

/** Runs a `pair` command on the runner's data dir (the same one the service uses) and returns the exit code. */
export function runPairCommand(
  args: string[],
  options: { config?: Config; out?: (line: string) => void } = {},
): number {
  const config = options.config ?? loadConfig(process.env, ["--runner"]);
  const ctx = createContext({ ...config, pollers: false });
  try {
    return run(args, {
      auth: ctx.services.machineAuth,
      machineName: ctx.services.settings.get().machineName,
      out: options.out ?? console.log,
    });
  } finally {
    ctx.db.close();
  }
}
