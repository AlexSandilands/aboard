import { TicketSystems, type TicketSystem, type TicketSystemPreset } from "@repo/contracts";
import type { IntegrationDot } from "./integrations.logic";

/** An id for a new system: its name as a slug, numbered when another system has it. Ids never change once used. */
export function newTicketSystemId(name: string, systems: readonly TicketSystem[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "tickets";
  const taken = new Set(systems.map((s) => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The list with a new system at the end: a copy of the preset's, or a blank one. */
export function addTicketSystem(systems: readonly TicketSystem[], preset: TicketSystemPreset | null): TicketSystem[] {
  const name = preset?.system.name ?? "Tickets";
  const taken = new Set(systems.map((s) => s.name));
  let unique = name;
  for (let n = 2; taken.has(unique); n++) unique = `${name} ${n}`;
  const base: TicketSystem = preset
    ? { ...preset.system, importTools: [...preset.system.importTools] }
    : { id: "", name, autoLink: false, importTools: [], importInstructions: "" };
  return [...systems, { ...base, id: newTicketSystemId(unique, systems), name: unique }];
}

/**
 * The list with one system changed, or why the change can't be saved. A blank optional field is left out, as the
 * server stores it.
 */
export function updateTicketSystem(
  systems: readonly TicketSystem[],
  id: string,
  patch: Partial<Omit<TicketSystem, "id">>,
): { systems: TicketSystem[] } | { error: string } {
  const next = systems.map((system) => {
    if (system.id !== id) return system;
    const merged: TicketSystem = { ...system, ...patch };
    for (const key of ["keyPattern", "urlPattern", "linkTemplate"] as const) {
      if (!merged[key]?.trim()) delete merged[key];
    }
    return merged;
  });
  const parsed = TicketSystems.safeParse(next);
  return parsed.success ? { systems: parsed.data } : { error: parsed.error.issues[0]?.message ?? "Not valid" };
}

export function removeTicketSystem(systems: readonly TicketSystem[], id: string): TicketSystem[] {
  return systems.filter((s) => s.id !== id);
}

export function ticketSystemsDot(systems: readonly TicketSystem[]): IntegrationDot {
  if (systems.length === 0) return { tone: "muted", label: "None set up" };
  return { tone: "success", label: systems.length === 1 ? "1 system" : `${systems.length} systems` };
}
