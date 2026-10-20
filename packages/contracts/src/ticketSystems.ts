import { z } from "zod";
import { CustomToolRule } from "./toolRules.ts";

// Ticket systems: the issue trackers the user configured (docs/features/ticket-systems.md). The board knows none
// itself; each system says what its keys and URLs look like, where a key's page is, and how to import one. Links to a
// ticket are stored as `{system, key}`, with `system` the id below.

export const TICKET_SYSTEM_NAME_MAX = 60;
export const TICKET_PATTERN_MAX = 500;
export const TICKET_INSTRUCTIONS_MAX = 4_000;
export const TICKET_IMPORT_TOOLS_MAX = 20;
export const TICKET_KEY_PLACEHOLDER = "{key}";

/** Compiles a pattern the user wrote, or null when it isn't a valid regular expression. */
const compile = (source: string, flags = ""): RegExp | null => {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};

/** How many capture groups a pattern has: an empty alternative makes it match "", which reports them all. */
const groupCount = (source: string): number => (compile(`${source}|`)?.exec("")?.length ?? 1) - 1;

const Pattern = z
  .string()
  .trim()
  .max(TICKET_PATTERN_MAX)
  .refine((source) => compile(source) !== null, "Not a valid regular expression");

export const TicketSystem = z.object({
  /** Stored in each ticket link's ref, so it never changes once links use it. */
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(TICKET_SYSTEM_NAME_MAX),
  /** A whole key, like `[A-Z][A-Z0-9]+-\d+`. Keys are found in text and pasted values with it. */
  keyPattern: Pattern.optional(),
  /** A ticket's URL; its first capture group is the key. Checked before the key pattern. */
  urlPattern: Pattern.refine((source) => groupCount(source) > 0, "Capture the key in a group: (...)").optional(),
  /** The page of a key, with `{key}` where the key goes, e.g. `https://example.atlassian.net/browse/{key}`. */
  linkTemplate: z
    .string()
    .trim()
    .max(TICKET_PATTERN_MAX)
    .refine((t) => t.includes(TICKET_KEY_PLACEHOLDER), `Put ${TICKET_KEY_PLACEHOLDER} where the key goes`)
    .refine((t) => /^https?:\/\//i.test(t), "Start with http:// or https://")
    .optional(),
  /** Link keys found in a task's title. */
  autoLink: z.boolean(),
  /** The MCP tools an import may call to read a ticket. */
  importTools: z.array(CustomToolRule).max(TICKET_IMPORT_TOOLS_MAX),
  /** What an import is told about reading this system's tickets: the tool to use, how to find an epic's children. */
  importInstructions: z.string().max(TICKET_INSTRUCTIONS_MAX),
});
export type TicketSystem = z.infer<typeof TicketSystem>;

/** Systems with unique ids: a second system with an id already used would never be matched. */
export const TicketSystems = z.array(TicketSystem).superRefine((systems, ctx) => {
  const seen = new Set<string>();
  systems.forEach((system, index) => {
    if (seen.has(system.id)) {
      ctx.addIssue({ code: "custom", message: `Another ticket system has the id "${system.id}"`, path: [index, "id"] });
    }
    seen.add(system.id);
  });
});

/** What a ticket link points at: a key in one of the configured systems. */
export const TicketRef = z.object({ system: z.string(), key: z.string() });
export type TicketRef = z.infer<typeof TicketRef>;

/** The page of a key, or null when the system has no link template. */
export function ticketHref(system: Pick<TicketSystem, "linkTemplate"> | null | undefined, key: string): string | null {
  return system?.linkTemplate ? system.linkTemplate.split(TICKET_KEY_PLACEHOLDER).join(encodeURIComponent(key)) : null;
}

/** "<System> KEY", with the system's id when it is no longer configured. */
export function ticketLabel(systems: readonly TicketSystem[] | null | undefined, ref: TicketRef): string {
  return `${systems?.find((s) => s.id === ref.system)?.name ?? ref.system} ${ref.key}`;
}

/** The first system whose URL pattern matches `url`, with the key it captured. */
export function matchTicketUrl(url: string, systems: readonly TicketSystem[]): TicketRef | null {
  for (const system of systems) {
    if (!system.urlPattern) continue;
    const match = compile(system.urlPattern)?.exec(url);
    const key = match?.slice(1).find(Boolean);
    if (key) return { system: system.id, key };
  }
  return null;
}

/** The first system whose key pattern matches the whole of `value`. */
export function matchTicketKey(value: string, systems: readonly TicketSystem[]): TicketRef | null {
  for (const system of systems) {
    if (system.keyPattern && compile(`^(?:${system.keyPattern})$`)?.test(value))
      return { system: system.id, key: value };
  }
  return null;
}

/**
 * Ticket keys mentioned in free text, de-duplicated in order of appearance. Only the configured systems' key patterns
 * count. Lookarounds keep a key from matching part of a longer word ("ISO-8601-1", "foo_ABC-1"), while
 * "/browse/ABC-1" and "(ABC-1)." still match.
 */
export function findTicketKeys(text: string | null | undefined, systems: readonly TicketSystem[]): TicketRef[] {
  if (!text) return [];
  const found: Array<TicketRef & { at: number }> = [];
  for (const system of systems) {
    if (!system.keyPattern) continue;
    const pattern = compile(`(?<![A-Za-z0-9_-])(?:${system.keyPattern})(?![A-Za-z0-9_]|-\\d)`, "g");
    for (const match of pattern ? text.matchAll(pattern) : []) {
      // An empty match would be no key at all.
      if (!match[0]) continue;
      // A key two systems both match belongs to the first, as when it is pasted.
      if (found.some((f) => f.key === match[0])) continue;
      found.push({ system: system.id, key: match[0], at: match.index });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(({ system, key }) => ({ system, key }));
}
