import { T3LaunchDialog } from "~/components/handoff/T3LaunchDialog";
import { AppSettingsDialog } from "./AppSettingsDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

/** App-level dialogs driven by useDialogs(). Mounted once at the root. */
export function AppDialogs() {
  return (
    <>
      <ProjectSettingsDialog />
      <AppSettingsDialog />
      <T3LaunchDialog />
    </>
  );
}
