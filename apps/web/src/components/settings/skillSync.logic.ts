import { BRAND, SKILL_SYNC_ROOTS, type SkillSyncHarnessStatus, type SkillSyncStatus } from "@repo/contracts";

type BadgeVariant = "success" | "warning" | "info" | "secondary";

/** The status badge of a harness's Board skill row; none while sync is off and nothing is installed. */
export function skillSyncBadge(status: SkillSyncHarnessStatus): { label: string; variant: BadgeVariant } | null {
  switch (status.state) {
    case "up_to_date":
      return { label: "Up to date", variant: "success" };
    case "out_of_date":
      // Sync rewrites it on the next start; with sync off it stays as it is.
      return { label: "Out of date", variant: status.enabled ? "info" : "warning" };
    case "edited":
      return { label: "Edited by you", variant: "warning" };
    case "not_installed":
      return status.enabled ? { label: "Not installed", variant: "warning" } : null;
  }
}

/** Where the skill goes for a harness, as the user would write it. */
export const skillSyncFolder = (status: Pick<SkillSyncHarnessStatus, "harness">): string =>
  `~/${SKILL_SYNC_ROOTS[status.harness]}/${BRAND.id}`;

/** The row's description: what the switch does, or what the user has to decide. */
export function skillSyncDescription(status: SkillSyncHarnessStatus): string {
  if (status.enabled && status.state === "edited") {
    return "Your copy differs from the app's, so it isn't updated. Overwrite it, or keep yours and stop syncing.";
  }
  if (status.enabled) return `Installed in ${skillSyncFolder(status)} and updated with the app.`;
  return `Install it in ${skillSyncFolder(status)} and keep it updated with the app.`;
}

/** What turning sync off asks, when there is a copy to delete. Null: just turn it off. */
export function skillSyncDisablePrompt(
  status: SkillSyncHarnessStatus,
): { description: string; edited: boolean } | null {
  if (status.state === "not_installed") return null;
  const edited = status.state === "edited";
  return {
    edited,
    description: edited
      ? `The skill in ${skillSyncFolder(status)} has your edits. Deleting it loses them; keeping it leaves it as it is, no longer updated.`
      : `Delete the skill from ${skillSyncFolder(status)}, or keep it there, no longer updated.`,
  };
}

/** The hint under the snippet's Copy button. */
export function snippetHint(snippet: SkillSyncStatus["snippet"] | undefined): string | null {
  if (!snippet?.copied) return null;
  return snippet.changedSinceCopied
    ? "Changed since you last copied it: paste the new version into your AGENTS.md."
    : "Unchanged since you last copied it.";
}
