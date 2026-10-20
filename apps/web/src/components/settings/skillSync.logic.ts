import type { SkillSyncHarnessStatus, SkillSyncStatus } from "@repo/contracts";

type BadgeVariant = "success" | "warning" | "info" | "secondary";

/** The status badge of a harness's Board skills row; none while sync is off and nothing is installed. */
export function skillSyncBadge(status: SkillSyncHarnessStatus): { label: string; variant: BadgeVariant } | null {
  switch (status.state) {
    case "up_to_date":
      return { label: "Up to date", variant: "success" };
    case "out_of_date":
      // Sync rewrites it on the next start; with sync off it stays as it is.
      return { label: "Out of date", variant: status.enabled ? "info" : "warning" };
    case "edited":
      return { label: status.installedByBoard ? "Edited by you" : "Not the app's copy", variant: "warning" };
    case "not_installed":
      return status.enabled ? { label: "Not installed", variant: "warning" } : null;
  }
}

/** The folder the server installs the skills in: the one the harness reads, which its env vars may move. */
export const skillSyncFolder = (status: Pick<SkillSyncHarnessStatus, "path">): string => status.path;

/** The row's description: what the switch does, or what the user has to decide. */
export function skillSyncDescription(status: SkillSyncHarnessStatus): string {
  if (status.enabled && status.state === "edited") {
    return status.installedByBoard
      ? "A skill you edited differs from the app's, so it isn't updated. Overwrite it, or keep yours and stop syncing."
      : "A skill the board didn't install is there, perhaps an older copy. Overwrite it with the app's, or keep it and stop syncing.";
  }
  if (status.enabled) return `Installed in ${skillSyncFolder(status)} and updated with the app.`;
  return `Install them in ${skillSyncFolder(status)} and keep them updated with the app.`;
}

/** What turning sync off asks, when there is a copy to delete. Null: just turn it off. */
export function skillSyncDisablePrompt(
  status: SkillSyncHarnessStatus,
): { description: string; edited: boolean } | null {
  if (status.state === "not_installed") return null;
  const edited = status.state === "edited";
  return {
    edited,
    description: !edited
      ? `Delete the skills from ${skillSyncFolder(status)}, or keep them there, no longer updated.`
      : status.installedByBoard
        ? `A skill in ${skillSyncFolder(status)} has your edits. Deleting it loses them; keeping it leaves it as it is, no longer updated.`
        : `A skill in ${skillSyncFolder(status)} isn't the app's copy. Deleting it loses any changes made to it; keeping it leaves it as it is.`,
  };
}

/** The hint under the snippet's Copy button. */
export function snippetHint(snippet: SkillSyncStatus["snippet"] | undefined): string | null {
  if (!snippet?.copied) return null;
  return snippet.changedSinceCopied
    ? "Changed since you last copied it: paste the new version into your AGENTS.md."
    : "Unchanged since you last copied it.";
}
