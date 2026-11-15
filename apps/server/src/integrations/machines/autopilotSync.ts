import { createHash } from "node:crypto";
import {
  MACHINE_AUTOPILOT_PATH,
  MachineAutopilotAck,
  type AutopilotMachine,
  type CopiedProject,
  type MachineAutopilotConfig,
} from "@repo/contracts";
import { startOfDay } from "../../autopilot/limits.ts";
import type { EventBus } from "../../bus.ts";
import type { Services } from "../../services/types.ts";
import type { RunGit } from "../backup.ts";
import { messageOf, type Logger } from "../util.ts";
import { remoteIdentity } from "./checkouts.ts";
import type { MachinesIntegration } from "./index.ts";

// A board's side of Autopilot on a connected machine (docs/features/remote-machines.md#autopilot-on-the-machine):
// what the board's Autopilot is goes to every machine that runs its own, whenever it changes, so the machine runs
// the same automations by the same switches while the board is off. The machine answers with what it took.

/** Changes come in bursts (a run publishes several); one send after the burst is enough. */
const PUSH_DEBOUNCE_MS = 500;

export interface AutopilotSync {
  /** Sends a machine the board's Autopilot, unless it already has it. Throws when the machine can't be reached. */
  sync(machineId: string): Promise<void>;
  /** What each connected machine has of the board's Autopilot, its limits and its runs, for the settings page. */
  machines(): AutopilotMachine[];
  /** Sends every machine what changed, soon; on Autopilot's own changes. */
  start(): void;
  stop(): void;
}

export function createAutopilotSync(deps: {
  services: () => Services;
  machines: Pick<MachinesIntegration, "request" | "can" | "list">;
  bus: EventBus;
  runGit: RunGit;
  log?: Logger;
}): AutopilotSync {
  const log = deps.log ?? console;
  const services = () => deps.services();
  /** Per machine, the revision of what it should have now, as last worked out. */
  const latest = new Map<string, string>();
  /** Per machine, what it last took: the revision, and whether Pause all was on in it. */
  const taken = new Map<string, { revision: string; paused: boolean }>();
  /** Machines being sent to now, so a burst of changes sends each once. */
  const sending = new Map<string, Promise<void>>();
  let again = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  /** The projects a pinned automation runs in, as the machine clones them: by repository. */
  const projectsFor = async (projectIds: readonly string[]): Promise<CopiedProject[]> => {
    const out: CopiedProject[] = [];
    for (const id of projectIds) {
      const project = services().projects.get(id);
      if (!project.workspaceRoot) continue;
      const result = await deps.runGit(["remote", "get-url", "origin"], project.workspaceRoot).catch(() => null);
      const remoteUrl = result?.code === 0 ? result.stdout.trim() : "";
      const remote = remoteUrl ? remoteIdentity(remoteUrl) : null;
      // Only a project with a repository can be cloned there.
      if (remote) out.push({ id, title: project.title, remote, remoteUrl });
    }
    return out;
  };

  const configFor = async (machineId: string): Promise<MachineAutopilotConfig> => {
    const { pinnedProjects, ...rest } = services().autopilot.machineConfig(machineId);
    const body = { ...rest, projects: await projectsFor(pinnedProjects) };
    // What is sent names itself: the same Autopilot gives the same revision, so an unchanged one isn't sent again.
    const revision = createHash("sha256").update(JSON.stringify(body)).digest("base64url").slice(0, 16);
    return { revision, ...body };
  };

  const send = async (machineId: string): Promise<void> => {
    // A runner from before Autopilot ran there takes none: the board keeps doing its tasks' Autopilot itself.
    if (deps.machines.can(machineId, "autopilot") === false) return;
    const config = await configFor(machineId);
    latest.set(machineId, config.revision);
    if (taken.get(machineId)?.revision === config.revision) return;
    const res = await deps.machines.request(machineId, MACHINE_AUTOPILOT_PATH, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok)
      throw new Error(`${services().machines.get(machineId).name} didn't take Autopilot's settings (${res.status})`);
    const ack = MachineAutopilotAck.parse(await res.json());
    taken.set(machineId, { revision: ack.revision, paused: config.paused });
    // The settings page shows whether it arrived.
    services().autopilot.touch();
  };

  const sync = (machineId: string): Promise<void> => {
    const going = sending.get(machineId);
    if (going) return going.catch(() => {}).then(() => sync(machineId));
    const next = send(machineId).finally(() => sending.delete(machineId));
    sending.set(machineId, next);
    return next;
  };

  const pushSoon = () => {
    for (const m of services().machines.list()) again.add(m.id);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const ids = again;
      again = new Set();
      for (const id of ids) {
        // Not reachable now: the next round of its log sends it.
        sync(id).catch((error: unknown) => {
          if (deps.machines.list().machines.find((m) => m.id === id)?.connection === "connected") {
            log.warn(`[machines] couldn't send Autopilot's settings: ${messageOf(error)}`);
          }
        });
      }
    }, PUSH_DEBOUNCE_MS);
    timer.unref();
  };

  return {
    sync,

    machines() {
      const s = services();
      const paused = s.autopilot.status().paused;
      const agents = s.autopilot
        .automations()
        .filter((a) => a.needsAgent)
        .map((a) => a.key);
      const today = startOfDay(new Date());
      const views = new Map(deps.machines.list().machines.map((m) => [m.id, m]));
      return s.machines.list().map((machine): AutopilotMachine => {
        const { limits, own } = s.autopilot.machineLimits(machine.id);
        const usage = s.autopilot.usage(agents, today, machine.id);
        const had = taken.get(machine.id);
        const runsAutopilot = deps.machines.can(machine.id, "autopilot");
        return {
          id: machine.id,
          name: machine.name,
          connection: views.get(machine.id)?.connection ?? "connecting",
          runsAutopilot,
          limits,
          ownLimits: own,
          // Unknown until worked out once (the next round of its log does): not synced until then.
          synced: had !== undefined && latest.get(machine.id) === had.revision,
          pauseDelivered: had?.paused === paused,
          activeRuns: usage.active,
          runsToday: usage.started,
        };
      });
    },

    start() {
      if (unsubscribe) return;
      unsubscribe = deps.bus.subscribe((event) => {
        if (event.type === "autopilot.changed" || event.type === "machines.changed") pushSoon();
      });
      pushSoon();
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
