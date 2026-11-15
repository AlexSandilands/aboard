import {
  BRAND,
  MACHINE_DESCRIPTOR_PATH,
  MACHINE_PAIR_PATH,
  MACHINE_PROTOCOL_VERSION,
  MACHINE_SESSION_PATH,
  MACHINE_STATUS_PATH,
  MACHINE_UPDATE_PATH,
  PairMachineInput,
  UpdateMachineRequest,
  serverPlatformOf,
  type MachineCapability,
  type MachineDescriptor,
  type MachineSession,
  type MachineStatus,
  type PairMachineResult,
} from "@repo/contracts";
import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { machinePairingOf, peerAddress } from "../guard.ts";
import { handle, noContent, parseBody } from "../respond.ts";

/** How long a status answer waits for the login checks, which start programs and may reach for the network. */
const STATUS_LOGINS_WAIT_MS = 4_000;

const CAPABILITIES: MachineCapability[] = ["pairing", "status", "update"];

/**
 * The machine API (docs/features/remote-machines.md#the-machine-api). Every server says who it is; the rest is a
 * runner's. The guard has already checked the token of everything but the descriptor and the pairing exchange, so a
 * route added here under `/machine/` is behind it without doing anything.
 */
export function registerMachineRoutes(app: Hono, { services, integrations, config, instanceId }: AppContext): void {
  const role = config.role ?? "board";
  const descriptor = (): MachineDescriptor => ({
    id: BRAND.id,
    instanceId,
    name: services.settings.get().machineName,
    version: BRAND.version,
    protocolVersion: MACHINE_PROTOCOL_VERSION,
    role,
    capabilities: role === "runner" ? CAPABILITIES : [],
    paired: services.machineAuth.paired(),
  });

  app.get(
    MACHINE_DESCRIPTOR_PATH,
    handle((c) => c.json(descriptor())),
  );
  if (role !== "runner") return;

  app.post(
    MACHINE_PAIR_PATH,
    handle(async (c) => {
      const { token, tokenId } = services.machineAuth.pair(await parseBody(c, PairMachineInput), peerAddress(c));
      // The one response that carries a token; nothing may keep it.
      c.header("cache-control", "no-store");
      return c.json({ token, tokenId, instanceId } satisfies PairMachineResult);
    }),
  );
  app.get(
    MACHINE_SESSION_PATH,
    handle((c) => {
      const { tokenId, board, pairedAt } = machinePairingOf(c);
      return c.json({ tokenId, board, pairedAt, machine: descriptor() } satisfies MachineSession);
    }),
  );
  // The board unpairing itself: its token stops working at once.
  app.delete(
    MACHINE_SESSION_PATH,
    handle((c) => {
      services.machineAuth.revoke(machinePairingOf(c).tokenId);
      return noContent(c);
    }),
  );

  const { logins, updater } = integrations.runnerHost;
  // What the board shows of this machine, read every half minute while it is connected.
  app.get(
    MACHINE_STATUS_PATH,
    handle(async (c) =>
      c.json({
        version: BRAND.version,
        platform: serverPlatformOf(process.platform, process.arch) ?? `${process.platform}-${process.arch}`,
        runsInFlight: services.autopilot.status().active.length,
        // Well inside the board's request timeout: a slow check answers with what was last known.
        logins: await logins.loginsWithin(STATUS_LOGINS_WAIT_MS),
        update: updater.state(),
        selfUpdate: updater.available(),
      } satisfies MachineStatus),
    ),
  );
  // The board asking this runner to move to its version. A runner never updates by itself. The request and its
  // answer keep their shape across protocol versions (UpdateMachineRequest): a board on another one still sends it.
  app.post(
    MACHINE_UPDATE_PATH,
    handle(async (c) => c.json(updater.request(await parseBody(c, UpdateMachineRequest)))),
  );
}
