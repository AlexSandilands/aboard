import { z } from "zod";
import { DEFAULT_RUNNER_PORT } from "./desktop.ts";
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
export const MachineCapability = z.enum(["pairing", "status", "update"]);
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

// --- What a paired board asks a runner (docs/features/remote-machines.md#status-and-logins) ---

export const MACHINE_STATUS_PATH = "/machine/status";
export const MACHINE_UPDATE_PATH = "/machine/update";

/** The logins a runner needs to run agents and push their work. */
export const MachineLoginName = z.enum(["claude", "codex", "gh", "git"]);
export type MachineLoginName = z.infer<typeof MachineLoginName>;

/**
 * `ok`: installed and logged in. `logged-out`: installed, with no login the check could find. `missing`: not on the
 * runner's PATH. `unknown`: the check itself failed.
 */
export const MachineLoginState = z.enum(["ok", "logged-out", "missing", "unknown"]);
export type MachineLoginState = z.infer<typeof MachineLoginState>;

export const MachineLogin = z.object({
  name: MachineLoginName,
  state: MachineLoginState,
  /** What to do about it, or what was found; null when there is nothing to add. */
  detail: z.string().nullable(),
});
export type MachineLogin = z.infer<typeof MachineLogin>;

/**
 * Where a runner is with an update its board asked for. `waiting`: it has runs in flight and updates once they end.
 * `restarting`: the new release is in place and the service is starting it. `failed` keeps the old version running.
 */
export const MachineUpdateState = z.object({
  state: z.enum(["idle", "waiting", "downloading", "restarting", "failed"]),
  targetVersion: z.string().nullable(),
  error: z.string().nullable(),
});
export type MachineUpdateState = z.infer<typeof MachineUpdateState>;

/** `GET /machine/status`: what the board shows about a connected machine. */
export const MachineStatus = z.object({
  version: z.string(),
  /** The release platform the runner runs on, `linux-x64` say. */
  platform: z.string(),
  /** Agent runs going on now; an update waits for none. */
  runsInFlight: z.number().int().nonnegative(),
  // A login this board doesn't know yet is dropped, as with capabilities.
  logins: z
    .array(z.unknown())
    .transform((list) => list.flatMap((l) => (MachineLogin.safeParse(l).success ? [MachineLogin.parse(l)] : []))),
  update: MachineUpdateState,
  /** Whether the runner can update itself: installed by the install script and running as its service. */
  selfUpdate: z.boolean(),
});
export type MachineStatus = z.infer<typeof MachineStatus>;

/** A release version: what a runner may be asked to update to, and nothing that could name a path. */
export const ReleaseVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, "A version like 1.4.2");

/**
 * `POST /machine/update`: the board asking the runner to move to `version`. The one request a board sends whatever
 * the protocol versions, since updating is how a mismatch ends: **its shape and its answer (`MachineUpdateState`)
 * must stay readable by every version**. `now` updates with runs in flight, which the restart ends.
 */
export const UpdateMachineRequest = z.object({
  version: ReleaseVersion,
  now: z.boolean().default(false),
});
export type UpdateMachineRequest = z.infer<typeof UpdateMachineRequest>;

/** -1, 0 or 1 as release version `a` is older than, the same as or newer than `b`. A pre-release is older than its release. */
export function compareReleaseVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

// --- The machines a board is connected to (docs/features/remote-machines.md#connecting-a-machine) ---

/**
 * A machine's short prefix: one to three capitals or digits, starting with a letter. A task made on the machine
 * while the board can't be reached is numbered with it (`#E7`), so it is unique and fixed once a task carries it.
 */
export const MachinePrefix = z
  .string()
  .trim()
  .transform((p) => p.toUpperCase())
  .pipe(z.string().regex(/^[A-Z][A-Z0-9]{0,2}$/, "One to three letters or digits, starting with a letter"));

/** The prefix to offer for a machine called `name` that isn't in `taken`: its initial, then initial and a letter or digit. */
export function suggestMachinePrefix(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((p) => p.toUpperCase()));
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const initial = /[A-Z]/.exec(letters)?.[0] ?? "M";
  const rest = letters.slice(letters.indexOf(initial) + 1);
  const second = [...rest.split(""), ..."23456789".split("")];
  const candidates = [initial, ...second.map((c) => initial + c)];
  for (const candidate of candidates) if (!used.has(candidate)) return candidate;
  for (const a of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!used.has(a + b)) return a + b;
  }
  return initial;
}

/**
 * Where ssh logs in: `host`, `user@host` or a name from `~/.ssh/config`. It becomes an argument to `ssh`, so it
 * can't start with a dash or hold anything a shell or ssh would read as more than a destination.
 */
export const SshTarget = z
  .string()
  .trim()
  .max(255)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.@:[\]%-]*$/, "A host, user@host or an ssh config name");

const Port = z.number().int().min(1).max(65535);

/** An SSH tunnel (`ssh -N -L`) to the runner's loopback port. */
export const SshMachineRoute = z.object({
  kind: z.literal("ssh"),
  target: SshTarget,
  /** The SSH port, when it isn't 22 or the one in `~/.ssh/config`. */
  port: Port.nullable().default(null),
  /** The port the runner listens on, on its own loopback. */
  remotePort: Port.default(DEFAULT_RUNNER_PORT),
});
export type SshMachineRoute = z.infer<typeof SshMachineRoute>;

/** The runner's own address: its Tailscale address or name over http, or an https URL. */
export const DirectMachineRoute = z.object({
  kind: z.literal("direct"),
  url: z.url().max(500),
});
export type DirectMachineRoute = z.infer<typeof DirectMachineRoute>;

/** One way to reach a machine. A machine's routes are tried in order; the first is the one preferred. */
export const MachineRoute = z.discriminatedUnion("kind", [SshMachineRoute, DirectMachineRoute]);
export type MachineRoute = z.infer<typeof MachineRoute>;

/** How a route reads in a sentence: `ssh engine` or the URL. */
export const machineRouteLabel = (route: MachineRoute): string =>
  route.kind === "ssh" ? `ssh ${route.target}${route.port ? `:${route.port}` : ""}` : route.url;

/**
 * `active`: the route in use. `standby`: not tried, as a better one works. `connecting`: being tried. `failed`: its
 * last try failed, and `retryAt` is when the next one is due.
 */
export const MachineRouteState = z.object({
  status: z.enum(["active", "standby", "connecting", "failed"]),
  error: z.string().nullable(),
  retryAt: z.string().nullable(),
});
export type MachineRouteState = z.infer<typeof MachineRouteState>;

/**
 * `connected`: reachable, paired and on our protocol. `connecting`: no route tried yet. `unreachable`: no route
 * works now; they are retried. `needs-update`: reachable on another protocol version, so nothing is exchanged with
 * it but the update request. `unpaired`: reachable, but it no longer accepts this board's token.
 */
export const MachineConnection = z.enum(["connected", "connecting", "unreachable", "needs-update", "unpaired"]);
export type MachineConnection = z.infer<typeof MachineConnection>;

/** A machine this board is connected to, with what was last seen of it and how it is reached now. */
export const Machine = z.object({
  id: z.string(),
  /** The runner's instance id: who must answer on every route. */
  instanceId: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  /** A task carries the prefix, so it can't change any more. */
  prefixFixed: z.boolean(),
  routes: z.array(MachineRoute),
  connection: MachineConnection,
  /** Why it isn't connected, in a sentence; null when it is. */
  error: z.string().nullable(),
  /** The index in `routes` of the one in use; null when none is. */
  activeRoute: z.number().int().nullable(),
  routeStates: z.array(MachineRouteState),
  /** As last seen; null until it has answered once. */
  version: z.string().nullable(),
  protocolVersion: z.number().int().nullable(),
  platform: z.string().nullable(),
  logins: z.array(MachineLogin).nullable(),
  runsInFlight: z.number().int().nullable(),
  selfUpdate: z.boolean().nullable(),
  /** The update this board asked for, as the runner last reported it; null when none was asked. */
  update: MachineUpdateState.nullable(),
  /** `older`: the board will update it. `newer`: the board is the one behind. Null when not known. */
  versionState: z.enum(["same", "older", "newer"]).nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Machine = z.infer<typeof Machine>;

const MachineDisplayName = z.string().trim().min(1).max(100);

/**
 * `POST /api/machines`: connect a machine. `ssh` installs the runner there over SSH and pairs with it; the answer
 * is the install to watch. `code` pairs with a runner already installed, by the code its install script printed.
 */
export const ConnectMachineInput = z.discriminatedUnion("via", [
  z.object({
    via: z.literal("ssh"),
    target: SshTarget,
    port: Port.nullable().optional(),
    /** Also let the runner be reached at its Tailscale address, and add that as a second route. */
    tailscale: z.boolean().default(false),
    name: MachineDisplayName.optional(),
    prefix: MachinePrefix.optional(),
  }),
  z.object({
    via: z.literal("code"),
    /** The runner's address, as its install script printed it. */
    url: z.url().max(500),
    code: z.string().trim().min(1).max(64),
    name: MachineDisplayName.optional(),
    prefix: MachinePrefix.optional(),
  }),
]);
export type ConnectMachineInput = z.infer<typeof ConnectMachineInput>;

export const MachineInstallStepKey = z.enum(["login", "download", "verify", "service", "pair", "connect"]);
export type MachineInstallStepKey = z.infer<typeof MachineInstallStepKey>;

/** The steps of an SSH install, in order, with what each is called while it runs. */
export const MACHINE_INSTALL_STEPS: ReadonlyArray<{ key: MachineInstallStepKey; label: string }> = [
  { key: "login", label: "Log in over SSH" },
  { key: "download", label: "Download the runner" },
  { key: "verify", label: "Check the download" },
  { key: "service", label: "Start the background service" },
  { key: "pair", label: "Pair with this board" },
  { key: "connect", label: "Connect" },
];

/** An install over SSH: started by `POST /api/machines`, then read until it is done or failed. */
export const MachineInstall = z.object({
  id: z.string(),
  target: z.string(),
  status: z.enum(["running", "done", "failed"]),
  steps: z.array(
    z.object({
      key: MachineInstallStepKey,
      label: z.string(),
      status: z.enum(["pending", "running", "done", "failed"]),
    }),
  ),
  /** What went wrong, in a sentence. */
  error: z.string().nullable(),
  /** The end of what the remote printed, with any pairing code taken out. */
  log: z.string(),
  /** The machine it made, once done. */
  machineId: z.string().nullable(),
});
export type MachineInstall = z.infer<typeof MachineInstall>;

/** What `POST /api/machines` answers: the machine (`code`) or the install to watch (`ssh`). */
export const ConnectMachineResult = z.object({
  machine: Machine.nullable(),
  install: MachineInstall.nullable(),
});
export type ConnectMachineResult = z.infer<typeof ConnectMachineResult>;

/** `PATCH /api/machines/:id`. `routes` replaces the list, in the order to try them. */
export const UpdateMachineInput = z.object({
  name: MachineDisplayName.optional(),
  prefix: MachinePrefix.optional(),
  routes: z.array(MachineRoute).min(1).max(8).optional(),
});
export type UpdateMachineInput = z.infer<typeof UpdateMachineInput>;

/** `POST /api/machines/:id/pair`: pair again with a machine that dropped this board, by a new code from it. */
export const RepairMachineInput = z.object({ code: z.string().trim().min(1).max(64) });
export type RepairMachineInput = z.infer<typeof RepairMachineInput>;

/** `POST /api/machines/:id/update`. `now` doesn't wait for the machine's runs to end. */
export const RequestMachineUpdateInput = z.object({ now: z.boolean().default(false) });
export type RequestMachineUpdateInput = z.infer<typeof RequestMachineUpdateInput>;

/** `GET /api/machines`. */
export const MachinesResponse = z.object({
  machines: z.array(Machine),
  /** The commands to run on a machine the board can't reach over SSH: they install the runner and print a pairing code. */
  installCommand: z.string(),
  installCommandTailscale: z.string(),
  /** Whether this board's version has a release a machine can install: false for one run from source. */
  releaseAvailable: z.boolean(),
});
export type MachinesResponse = z.infer<typeof MachinesResponse>;
