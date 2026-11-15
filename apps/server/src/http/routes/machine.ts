import {
  BRAND,
  MACHINE_DESCRIPTOR_PATH,
  MACHINE_PAIR_PATH,
  MACHINE_PROTOCOL_VERSION,
  MACHINE_SESSION_PATH,
  PairMachineInput,
  type MachineCapability,
  type MachineDescriptor,
  type MachineSession,
  type PairMachineResult,
} from "@repo/contracts";
import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { machinePairingOf } from "../guard.ts";
import { handle, noContent, parseBody } from "../respond.ts";

const CAPABILITIES: MachineCapability[] = ["pairing"];

/**
 * The machine API (docs/features/remote-machines.md#the-machine-api). Every server says who it is; the rest is a
 * runner's. The guard has already checked the token of everything but the descriptor and the pairing exchange, so a
 * route added here under `/machine/` is behind it without doing anything.
 */
export function registerMachineRoutes(app: Hono, { services, config, instanceId }: AppContext): void {
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
      const { token, tokenId } = services.machineAuth.pair(await parseBody(c, PairMachineInput));
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
}
