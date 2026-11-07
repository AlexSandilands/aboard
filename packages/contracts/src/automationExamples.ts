import {
  AutomationBundle,
  AUTOMATION_BUNDLE_FORMAT,
  PLAIN_BUNDLE_VERSION,
  SCRIPT_BUNDLE_VERSION,
} from "./automationBundle.ts";
import { BRAND } from "./brand.ts";

// Automations shipped as files anyone can import (docs/features/autopilot.md#sharing-automations). They are ordinary bundles: the
// import screen reads them like a file from someone else, and the importer fills in their inputs and tool slots.

export interface AutomationExample {
  id: string;
  title: string;
  bundle: AutomationBundle;
}

/**
 * Files the import page offers as examples. Review repo PRs, the last one, was retired by Review PRs' other people's
 * PRs (#21); the gallery's recipes below are the ready-made ones now.
 */
export const AUTOMATION_EXAMPLES: readonly AutomationExample[] = [];

// ── Recipes ──────────────────────────────────────────────────────────────
// Small, ready-made automations for the Add gallery (docs/features/autopilot.md#the-add-gallery). Each opens on the
// import page like a file someone shared, so the user reads it, fills in anything it asks for and imports it, in Preview.

export interface AutomationRecipe {
  id: string;
  title: string;
  /** One line for its card. */
  blurb: string;
  /** What kind of automation it is, for the card's badge ("Agent · when a task moves"). */
  kind: string;
  bundle: AutomationBundle;
}

const SUMMARISE_ON_REVIEW = AutomationBundle.parse({
  format: AUTOMATION_BUNDLE_FORMAT,
  version: PLAIN_BUNDLE_VERSION,
  name: "Summarise on Review",
  description: "When a task moves into Review, an agent adds a note saying what changed and what to check.",
  trigger: { kind: "status_change", to: "review" },
  action: {
    kind: "agent",
    prompt: `{{task.title}} (#{{task.number}}) has just moved to Review. Call get_task("{{task.id}}") on the ${BRAND.id} MCP server and read its plan, notes and links. Then add_note a short summary for the reviewer: what changed, what to check first, and anything left undone. Don't change the task or its plan.`,
    model: { tier: "light" },
  },
});

const NUDGE_STALE_WORK = AutomationBundle.parse({
  format: AUTOMATION_BUNDLE_FORMAT,
  version: PLAIN_BUNDLE_VERSION,
  name: "Nudge stale work",
  description: "When a task sits in In Progress for 48 hours, an agent reads it and adds a note saying what is left.",
  trigger: { kind: "stale", status: "in_progress", hours: 48 },
  action: {
    kind: "agent",
    prompt: `{{task.title}} (#{{task.number}}) has had no activity for two days. Call get_task("{{task.id}}") on the ${BRAND.id} MCP server, read its plan and notes, then add_note saying what is left and what looks blocked. Don't change the plan or move the task.`,
    model: { tier: "light" },
  },
});

const BRANCH_CLEANUP = AutomationBundle.parse({
  format: AUTOMATION_BUNDLE_FORMAT,
  version: SCRIPT_BUNDLE_VERSION,
  name: "Friday branch cleanup",
  description:
    "Every Friday at 16:00, lists the branches already merged into the default branch. It only lists them: it deletes nothing.",
  trigger: { kind: "schedule", schedule: { kind: "weekly", days: [5], time: "16:00" } },
  action: {
    kind: "script",
    language: "sh",
    body: `#!/bin/sh
# Lists local branches already merged into origin's default branch. Read-only: nothing is deleted.
git fetch --quiet origin || echo "Couldn't fetch origin: comparing with what is already here." >&2
base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
base=\${base:-main}
git rev-parse --verify --quiet "origin/$base" >/dev/null || { echo "No origin/$base to compare with." >&2; exit 1; }
echo "Branches merged into origin/$base:"
merged=$(git branch --merged "origin/$base" | grep -v -E "^\\*|^\\s*($base|main|master)$") || true
echo "\${merged:-(none)}"
`,
    timeoutSeconds: 60,
  },
});

export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
  {
    id: "summarise-on-review",
    title: "Summarise on Review",
    blurb: "When a task moves into Review, an agent adds a note for the reviewer.",
    kind: "Agent · when a task moves",
    bundle: SUMMARISE_ON_REVIEW,
  },
  {
    id: "nudge-stale-work",
    title: "Nudge stale work",
    blurb: "A task idle in In Progress for 48 hours gets a note on what is left.",
    kind: "Agent · when a task goes quiet",
    bundle: NUDGE_STALE_WORK,
  },
  {
    id: "friday-branch-cleanup",
    title: "Friday branch cleanup",
    blurb: "A script lists merged branches every Friday. It deletes nothing.",
    kind: "Script · on a schedule",
    bundle: BRANCH_CLEANUP,
  },
];
