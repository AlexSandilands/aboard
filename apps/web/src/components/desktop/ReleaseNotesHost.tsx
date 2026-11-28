import { ReleaseNotesDialog } from "./ReleaseNotesDialog";
import { useReleaseNotes } from "./useReleaseNotes";

/**
 * Mounted once in the AppShell: opens the release notes on the first launch after an update, and holds the dialog
 * Settings opens. Renders nothing outside the desktop shell.
 */
export function ReleaseNotesHost() {
  const notes = useReleaseNotes(true);
  if (!notes) return null;
  return (
    <ReleaseNotesDialog
      bridge={notes.bridge}
      currentVersion={notes.whatsNew.currentVersion}
      showReleaseNotes={notes.whatsNew.showReleaseNotes}
      onShowReleaseNotesChange={notes.setShowReleaseNotes}
    />
  );
}
