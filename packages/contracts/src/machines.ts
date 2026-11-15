import { z } from "zod";
import { ServerRole } from "./schemas.ts";

// The machine API: what a board (bridge) and a runner on another machine say to each other
// (docs/features/remote-machines.md, ADR 0015). Everything is under `/machine/`.

/**
 * The version of the machine API a server speaks. A board and a runner exchange anything beyond the descriptor and
 * pairing only when theirs are compatible; app versions don't matter. Raise it when a change would make an older
 * peer misread a newer one.
 */
export const MACHINE_PROTOCOL_VERSION = 1;

/** Whether two servers may talk. Equality today; the one place to loosen it when a version stays readable. */
export const machineProtocolCompatible = (ours: number, theirs: number): boolean => ours === theirs;

export const MACHINE_DESCRIPTOR_PATH = "/machine/descriptor";
export const MACHINE_PAIR_PATH = "/machine/pair";
export const MACHINE_SESSION_PATH = "/machine/session";

/** What a runner can do, so a board never has to guess from its version. */
export const MachineCapability = z.enum(["pairing"]);
export type MachineCapability = z.infer<typeof MachineCapability>;

/**
 * `GET /machine/descriptor`, served without a token: who this server is. A board reads it before it sends a pairing
 * code or a token anywhere, and sends neither unless `instanceId` is the one it expects.
 */
export const MachineDescriptor = z.object({
  /** The product id, so a board can tell our server from whatever else answers on the address. */
  id: z.string(),
  /** The data dir's instance id: the machine's identity, which never changes. */
  instanceId: z.uuid(),
  /** What the user calls the machine: its hostname unless set. */
  name: z.string(),
  version: z.string(),
  protocolVersion: z.number().int().positive(),
  role: ServerRole,
  /** Capabilities this board doesn't know yet are dropped, not an error: a newer runner stays readable. */
  capabilities: z.array(z.string()).transform((list) => list.filter((c) => MachineCapability.safeParse(c).success)),
  /** Whether a board is paired with it. A runner serves one board, so a paired one refuses any other. */
  paired: z.boolean(),
});
export type MachineDescriptor = z.infer<typeof MachineDescriptor>;

/** The board a runner is paired with. */
export const PairedBoard = z.object({
  instanceId: z.uuid(),
  name: z.string().trim().min(1).max(100),
});
export type PairedBoard = z.infer<typeof PairedBoard>;

/** `POST /machine/pair`: a one-time pairing code, and who is asking. */
export const PairMachineInput = z.object({
  code: z.string().trim().min(1).max(64),
  board: PairedBoard,
});
export type PairMachineInput = z.infer<typeof PairMachineInput>;

/** The token is returned this once and stored only hashed on the runner. */
export const PairMachineResult = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1),
  instanceId: z.uuid(),
});
export type PairMachineResult = z.infer<typeof PairMachineResult>;

/** `GET /machine/session`: what the token that asked is good for. */
export const MachineSession = z.object({
  tokenId: z.string(),
  board: PairedBoard,
  pairedAt: z.string(),
  machine: MachineDescriptor,
});
export type MachineSession = z.infer<typeof MachineSession>;
