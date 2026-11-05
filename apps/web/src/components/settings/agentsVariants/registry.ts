import { aVariant } from "./a";
import { bVariant } from "./b";
import { baselineVariant } from "./baseline";
import { cVariant } from "./c";
import { dVariant } from "./d";
import type { AgentsVariant } from "./types";

// One line per variant: its import above and its entry here.
export const AGENTS_VARIANTS: ReadonlyArray<AgentsVariant> = [baselineVariant, aVariant, bVariant, cVariant, dVariant];

/** The variant the viewer picked, else the newest one. */
export function agentsVariant(id: string | null): AgentsVariant {
  return AGENTS_VARIANTS.find((v) => v.id === id) ?? AGENTS_VARIANTS.at(-1)!;
}
