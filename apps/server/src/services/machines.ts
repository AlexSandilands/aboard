import { randomUUID } from "node:crypto";
import {
  MachinePrefix,
  MachineRoute as MachineRouteSchema,
  suggestMachinePrefix,
  type MachineLogin,
  type MachineRoute,
  type UpdateMachineInput,
} from "@repo/contracts";
import { z } from "zod";
import type { MachineRecord } from "../db/repos/machines.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";

// The machines a board is connected to, as stored (docs/features/remote-machines.md#connecting-a-machine): who each
// is, its prefix and its routes. Reaching them is integrations/machines; this is only what is remembered.

/** What a machine said of itself when it last answered. */
export interface MachineObservation {
  version: string;
  protocolVersion: number;
  platform?: string | null;
  logins?: MachineLogin[] | null;
}

export interface MachinesService {
  list(): MachineRecord[];
  /** Throws NOT_FOUND. */
  get(id: string): MachineRecord;
  byInstance(instanceId: string): MachineRecord | null;
  /**
   * Records a machine the board has just paired with. The prefix is the one asked for, or one suggested from the
   * name. Throws CONFLICT when the machine is already connected or the prefix is another machine's.
   */
  add(input: { instanceId: string; name: string; prefix?: string | undefined; routes: MachineRoute[] }): MachineRecord;
  /** Renames, re-prefixes or re-routes. Throws CONFLICT for a prefix in use, or one that can no longer change. */
  update(id: string, input: UpdateMachineInput): MachineRecord;
  /** Forgets the machine. Throws NOT_FOUND. */
  remove(id: string): void;
  /** Keeps what the machine said of itself, stamped with now. A machine removed meanwhile is ignored. */
  observe(id: string, seen: MachineObservation): MachineRecord | null;
  /** Fixes the prefix for good: a task now carries it. */
  fixPrefix(id: string): MachineRecord;
  /** A prefix no machine has, from `name`. */
  suggestPrefix(name: string): string;
}

export function createMachinesService(core: Pick<Core, "repos" | "now" | "write">): MachinesService {
  const repo = core.repos.machines;

  const get = (id: string): MachineRecord => {
    const machine = repo.get(id);
    if (!machine) throw notFound("Machine", id);
    return machine;
  };
  const prefixes = (exceptId?: string) =>
    repo
      .all()
      .filter((m) => m.id !== exceptId)
      .map((m) => m.prefix);
  /** Nothing unreadable is stored: a route this version can't parse would cost the machine all of its routes. */
  const validRoutes = (routes: MachineRoute[]): MachineRoute[] => {
    const parsed = z.array(MachineRouteSchema).min(1).safeParse(routes);
    if (!parsed.success) throw new AppError("VALIDATION", "A machine needs at least one route, each a valid one");
    return parsed.data;
  };
  const requireFreePrefix = (prefix: string, exceptId?: string): void => {
    const owner = repo.all().find((m) => m.id !== exceptId && m.prefix === prefix);
    if (owner) throw new AppError("CONFLICT", `The prefix ${prefix} is ${owner.name}'s. Pick another.`);
  };

  return {
    list: () => repo.all(),
    get,
    byInstance: (instanceId) => repo.byInstance(instanceId),

    add({ instanceId, name, prefix, routes }) {
      return core.write(() => {
        const known = repo.byInstance(instanceId);
        if (known) throw new AppError("CONFLICT", `That machine is already connected, as ${known.name}.`);
        const chosen = prefix === undefined ? suggestMachinePrefix(name, prefixes()) : MachinePrefix.parse(prefix);
        requireFreePrefix(chosen);
        const machine: MachineRecord = {
          id: randomUUID(),
          instanceId,
          name,
          prefix: chosen,
          prefixFixed: false,
          routes: validRoutes(routes),
          version: null,
          protocolVersion: null,
          platform: null,
          logins: null,
          lastSeenAt: null,
          createdAt: core.now().toISOString(),
        };
        repo.insert(machine);
        return machine;
      });
    },

    update(id, input) {
      return core.write(() => {
        const machine = get(id);
        if (input.prefix !== undefined && input.prefix !== machine.prefix) {
          if (machine.prefixFixed) {
            throw new AppError(
              "CONFLICT",
              `Tasks are numbered with ${machine.name}'s prefix ${machine.prefix}, so it can't change any more.`,
            );
          }
          requireFreePrefix(input.prefix, id);
        }
        const next: MachineRecord = {
          ...machine,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
          ...(input.routes !== undefined ? { routes: validRoutes(input.routes) } : {}),
        };
        repo.update(next);
        return next;
      });
    },

    remove(id) {
      core.write(() => {
        if (repo.delete(id) === 0) throw notFound("Machine", id);
      });
    },

    observe(id, seen) {
      return core.write(() => {
        const machine = repo.get(id);
        if (!machine) return null;
        const next: MachineRecord = {
          ...machine,
          version: seen.version,
          protocolVersion: seen.protocolVersion,
          // Kept from the last full answer when this one (a descriptor alone) doesn't carry them.
          platform: seen.platform ?? machine.platform,
          logins: seen.logins ?? machine.logins,
          lastSeenAt: core.now().toISOString(),
        };
        repo.update(next);
        return next;
      });
    },

    fixPrefix(id) {
      return core.write(() => {
        const machine = get(id);
        if (machine.prefixFixed) return machine;
        const next = { ...machine, prefixFixed: true };
        repo.update(next);
        return next;
      });
    },

    suggestPrefix: (name) => suggestMachinePrefix(name, prefixes()),
  };
}
