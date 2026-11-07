import {
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_START_PLANNED,
  AUTOPILOT_UNSTICK,
  isOnMode,
  type AutopilotAutomation,
  type AutopilotOnMode,
  type AutopilotScopeEntry,
} from "./autopilot.ts";
import { AUTOPILOT_DIGEST } from "./digest.ts";
import { AUTOPILOT_MERGE_EPIC_PRS } from "./delivery.ts";
import { AUTOPILOT_FIX_PRS, AUTOPILOT_REVIEW_PRS } from "./prReview.ts";

// Quick setup: a one-off preset that switches a sensible set of built-in automations on for the whole board. It
// stores no level: each automation it touches is an ordinary board switch afterwards, and the next Quick setup reads
// what is on now. The list it shows and the writes it makes both come from `quickSetupChanges`, so they can't differ.

export const QUICK_SETUP_LEVELS = ["notify", "assist", "hands_off"] as const;
export type QuickSetupLevel = (typeof QUICK_SETUP_LEVELS)[number];

/** Keys of built-ins this file names that have no exported constant of their own. */
const AUTO_ARCHIVE = "auto_archive";
const UNBLOCK_DEPENDENTS = "unblock_dependents";

interface PresetItem {
  automation: string;
  /** What it does here, in a line, for the list. */
  detail: string;
  /**
   * Starts in Preview when the user keeps "Start in Preview" on: it starts an agent, or acts on GitHub, which an
   * unwatched first run shouldn't do before they have seen what it would do.
   */
  previewable: boolean;
}

export interface QuickSetupPreset {
  level: QuickSetupLevel;
  label: string;
  blurb: string;
  items: readonly PresetItem[];
}

const ARCHIVE_ITEM: PresetItem = {
  automation: AUTO_ARCHIVE,
  detail: "Archives tasks that have sat in Done a while.",
  previewable: false,
};
const DIGEST_ITEM: PresetItem = {
  automation: AUTOPILOT_DIGEST,
  detail: "A plain list of what changed on the board.",
  previewable: false,
};
const UNSTICK_ITEM: PresetItem = {
  automation: AUTOPILOT_UNSTICK,
  detail: "Tells you about work that has gone quiet or a thread waiting on you.",
  previewable: false,
};
const REVIEW_ITEM: PresetItem = {
  automation: AUTOPILOT_REVIEW_PRS,
  detail: "An agent reviews the PRs your tasks open and comments on them.",
  previewable: true,
};
const FIX_ITEM: PresetItem = {
  automation: AUTOPILOT_FIX_PRS,
  detail: "An agent fixes failing checks, conflicts and review findings on those PRs.",
  previewable: true,
};

export const QUICK_SETUP_PRESETS: Record<QuickSetupLevel, QuickSetupPreset> = {
  notify: {
    level: "notify",
    label: "Notify",
    blurb: "Tells you what changed and what has stalled. No agent starts and nothing is merged.",
    items: [
      DIGEST_ITEM,
      UNSTICK_ITEM,
      { automation: UNBLOCK_DEPENDENTS, detail: "Tells you when a task's last blocker finishes.", previewable: false },
      ARCHIVE_ITEM,
    ],
  },
  assist: {
    level: "assist",
    label: "Assist",
    blurb: "Agents review and fix the PRs your tasks open. They never start work or merge.",
    items: [REVIEW_ITEM, FIX_ITEM, DIGEST_ITEM, UNSTICK_ITEM, ARCHIVE_ITEM],
  },
  hands_off: {
    level: "hands_off",
    label: "Hands-off",
    blurb:
      "Agents start the tasks you flag, keep them moving and merge ready PRs into epic branches. Main stays yours.",
    items: [
      {
        automation: AUTOPILOT_START_PLANNED,
        detail: "Starts Planned tasks you flag for Autopilot.",
        previewable: true,
      },
      {
        automation: AUTOPILOT_ORCHESTRATE,
        detail: "Keeps epics moving while their work is in flight.",
        previewable: true,
      },
      REVIEW_ITEM,
      FIX_ITEM,
      {
        automation: AUTOPILOT_MERGE_EPIC_PRS,
        detail: "Merges ready PRs into epic branches. Merging into main stays off.",
        previewable: true,
      },
      UNSTICK_ITEM,
      ARCHIVE_ITEM,
    ],
  },
};

export const quickSetupLabel = (level: QuickSetupLevel): string => QUICK_SETUP_PRESETS[level].label;

/** What one automation of the preset does, in the order the list shows them. */
export type QuickSetupChange =
  | {
      kind: "switch_on";
      automation: string;
      title: string;
      detail: string;
      /** The mode it is switched to at the board. */
      mode: AutopilotOnMode;
      /** Projects that switch it Off for themselves, which this doesn't override. */
      overriddenIn: string[];
    }
  /** Already on at the board: left as it is, in whichever mode it is in. */
  | { kind: "already_on"; automation: string; title: string; detail: string; mode: AutopilotOnMode }
  /** Can't be switched on yet: `reason` is the automation's own "won't work until you fill in …". */
  | { kind: "blocked"; automation: string; title: string; detail: string; reason: string };

export interface QuickSetupInput {
  /** The catalogue (`AutopilotOverview.automations`). A preset's automation that isn't in it is left out. */
  automations: readonly Pick<AutopilotAutomation, "key" | "title" | "blocked">[];
  /** The board scope's entries. An automation with none is off. */
  board: readonly Pick<AutopilotScopeEntry, "automation" | "mode">[];
  /** Each active project's own entries, to say where an Off there keeps an automation from running. */
  projects?: readonly { title: string; entries: readonly Pick<AutopilotScopeEntry, "automation" | "mode">[] }[];
  /** Start the automations the preset marks previewable in Preview, not On. Default true. */
  preview?: boolean;
}

/** The changes `level` makes from the current switches: what it switches on, and where. Pure; it writes nothing. */
export function quickSetupChanges(level: QuickSetupLevel, input: QuickSetupInput): QuickSetupChange[] {
  const preview = input.preview ?? true;
  const changes: QuickSetupChange[] = [];
  for (const item of QUICK_SETUP_PRESETS[level].items) {
    const automation = input.automations.find((a) => a.key === item.automation);
    if (!automation) continue;
    const base = { automation: automation.key, title: automation.title, detail: item.detail };
    const current = input.board.find((entry) => entry.automation === automation.key)?.mode ?? "inherit";
    if (isOnMode(current)) {
      changes.push({ kind: "already_on", ...base, mode: current });
    } else if (automation.blocked) {
      changes.push({ kind: "blocked", ...base, reason: automation.blocked });
    } else {
      changes.push({
        kind: "switch_on",
        ...base,
        mode: item.previewable && preview ? "preview" : "on",
        overriddenIn: (input.projects ?? [])
          .filter((p) => p.entries.some((entry) => entry.automation === automation.key && entry.mode === "off"))
          .map((p) => p.title),
      });
    }
  }
  return changes;
}

/** The board-scope writes that apply the changes: each automation to switch on, with its mode. */
export function quickSetupWrites(
  changes: readonly QuickSetupChange[],
): { automation: string; mode: AutopilotOnMode }[] {
  return changes.flatMap((change) =>
    change.kind === "switch_on" ? [{ automation: change.automation, mode: change.mode }] : [],
  );
}

/** "Hands-off applied: 3 on, 2 in Preview", or why nothing changed. */
export function quickSetupSummary(level: QuickSetupLevel, changes: readonly QuickSetupChange[]): string {
  const switched = changes.filter((c) => c.kind === "switch_on");
  const on = switched.filter((c) => c.mode === "on").length;
  const previewed = switched.length - on;
  const label = quickSetupLabel(level);
  if (switched.length === 0) return `${label}: everything it covers is already on`;
  const parts = [on > 0 ? `${on} on` : null, previewed > 0 ? `${previewed} in Preview` : null].filter(Boolean);
  return `${label} applied: ${parts.join(", ")}`;
}
