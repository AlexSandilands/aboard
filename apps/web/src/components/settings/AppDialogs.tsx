import { AppSettingsDialog } from "./AppSettingsDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

/** Project settings + app settings dialogs, driven by useDialogs(). Mounted once at the root. */
export function AppDialogs() {
  return (
    <>
      <ProjectSettingsDialog />
      <AppSettingsDialog />
    </>
  );
}
