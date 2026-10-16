import { T3LaunchDialog } from "~/components/handoff/T3LaunchDialog";
import { MergePrDialog } from "~/components/merge/MergePrDialog";
import { SessionWarningDialog } from "~/components/sessions/SessionWarningDialog";
import { TemplateDraftDialog } from "~/components/templates/TemplateDraftDialog";
import { AppSettingsDialog } from "./AppSettingsDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

/** App-level dialogs driven by useDialogs(). Mounted once at the root. */
export function AppDialogs() {
  return (
    <>
      <ProjectSettingsDialog />
      <AppSettingsDialog />
      <T3LaunchDialog />
      <MergePrDialog />
      <SessionWarningDialog />
      <TemplateDraftDialog />
    </>
  );
}
