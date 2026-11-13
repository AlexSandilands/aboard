import type { AttentionReason } from "@repo/contracts";

import { SECTION_ATTENTION, SECTION_TITLES, type SectionId } from "./sections.logic";

/** Reasons with a callout of their own above the flags, which says more than a row would and has their Dismiss. */
const OWN_CALLOUT: ReadonlySet<AttentionReason["kind"]> = new Set(["agent_request", "import_failed"]);

/** The reasons the panel's flags strip lists: every one but those with their own callout. */
export function stripFlags<T extends Pick<AttentionReason, "kind">>(reasons: ReadonlyArray<T>): T[] {
  return reasons.filter((r) => !OWN_CALLOUT.has(r.kind));
}

/** The panel section a flag comes from ("Sessions", "Links"), so its row says where to look; null for none. */
export function flagSection(kind: AttentionReason["kind"]): string | null {
  const id = (Object.keys(SECTION_ATTENTION) as SectionId[]).find((s) => SECTION_ATTENTION[s]?.includes(kind));
  return id ? SECTION_TITLES[id] : null;
}
