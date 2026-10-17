import { DigestDialog } from "~/components/digest/DigestDialog";
import { SessionLaunchDialog } from "~/components/handoff/SessionLaunchDialog";
import { T3LaunchDialog } from "~/components/handoff/T3LaunchDialog";
import { MergePrDialog } from "~/components/merge/MergePrDialog";
import { SessionWarningDialog } from "~/components/sessions/SessionWarningDialog";
import { TemplateDraftDialog } from "~/components/templates/TemplateDraftDialog";

/** App-level dialogs driven by useDialogs(). Mounted once at the root. */
export function AppDialogs() {
  return (
    <>
      <DigestDialog />
      <T3LaunchDialog />
      <SessionLaunchDialog />
      <MergePrDialog />
      <SessionWarningDialog />
      <TemplateDraftDialog />
    </>
  );
}
