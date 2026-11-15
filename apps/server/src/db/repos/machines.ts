import { MachineLogin, MachineRoute } from "@repo/contracts";
import { z } from "zod";
import { parseJson } from "../database.ts";
import type { Sql } from "./sql.ts";

/** A connected machine as stored: who it is, how to reach it, and what it last said of itself. */
export interface MachineRecord {
  id: string;
  instanceId: string;
  name: string;
  prefix: string;
  prefixFixed: boolean;
  routes: MachineRoute[];
  version: string | null;
  protocolVersion: number | null;
  platform: string | null;
  logins: MachineLogin[] | null;
  lastSeenAt: string | null;
  createdAt: string;
}

interface MachineRow {
  id: string;
  instance_id: string;
  name: string;
  prefix: string;
  prefix_fixed: number;
  routes_json: string;
  version: string | null;
  protocol_version: number | null;
  platform: string | null;
  logins_json: string | null;
  last_seen_at: string | null;
  created_at: string;
}

const Routes = z.array(MachineRoute);
const Logins = z.array(MachineLogin);

const recordOf = (r: MachineRow): MachineRecord => ({
  id: r.id,
  instanceId: r.instance_id,
  name: r.name,
  prefix: r.prefix,
  prefixFixed: r.prefix_fixed === 1,
  // A route kind a later version wrote would fail the parse; such a machine has no routes this version can use.
  routes: Routes.safeParse(parseJson(r.routes_json)).data ?? [],
  version: r.version,
  protocolVersion: r.protocol_version,
  platform: r.platform,
  logins: r.logins_json === null ? null : (Logins.safeParse(parseJson(r.logins_json)).data ?? null),
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
});

const rowOf = (m: MachineRecord): MachineRow => ({
  id: m.id,
  instance_id: m.instanceId,
  name: m.name,
  prefix: m.prefix,
  prefix_fixed: m.prefixFixed ? 1 : 0,
  routes_json: JSON.stringify(m.routes),
  version: m.version,
  protocol_version: m.protocolVersion,
  platform: m.platform,
  logins_json: m.logins === null ? null : JSON.stringify(m.logins),
  last_seen_at: m.lastSeenAt,
  created_at: m.createdAt,
});

/** Typed access to the machines a board is connected to. */
export function createMachinesRepo(sql: Sql) {
  return {
    all(): MachineRecord[] {
      return sql.all<MachineRow>("SELECT * FROM machines ORDER BY created_at, id").map(recordOf);
    },
    get(id: string): MachineRecord | null {
      const row = sql.get<MachineRow>("SELECT * FROM machines WHERE id = ?", id);
      return row ? recordOf(row) : null;
    },
    byInstance(instanceId: string): MachineRecord | null {
      const row = sql.get<MachineRow>("SELECT * FROM machines WHERE instance_id = ?", instanceId);
      return row ? recordOf(row) : null;
    },
    insert(machine: MachineRecord): void {
      sql.insert("machines", { ...rowOf(machine) });
    },
    update(machine: MachineRecord): void {
      sql.update("machines", { ...rowOf(machine) });
    },
    /** How many rows went. */
    delete(id: string): number {
      return Number(sql.run("DELETE FROM machines WHERE id = ?", id).changes);
    },
  };
}
