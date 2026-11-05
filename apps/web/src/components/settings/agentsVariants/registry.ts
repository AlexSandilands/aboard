import { bVariant } from "./b";
import { baselineVariant } from "./baseline";
import type { AgentsVariant } from "./types";

// One line per variant: its import above and its entry here.
export const AGENTS_VARIANTS: ReadonlyArray<AgentsVariant> = [baselineVariant, bVariant];

/** The variant the viewer picked, else the newest one. */
export function agentsVariant(id: string | null): AgentsVariant {
  return AGENTS_VARIANTS.find((v) => v.id === id) ?? AGENTS_VARIANTS.at(-1)!;
}
