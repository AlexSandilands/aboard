import { ImagePreviewDialog } from "~/components/attachments/ImagePreviewDialog";
import { DigestDialog } from "~/components/digest/DigestDialog";
import { PlanSessionDialog, PlanTasksDialog } from "~/components/handoff/PlanTasksDialog";
import { SessionLaunchDialog } from "~/components/handoff/SessionLaunchDialog";
import { T3LaunchDialog } from "~/components/handoff/T3LaunchDialog";
import { MergePrDialog } from "~/components/merge/MergePrDialog";
import { SessionWarningDialog } from "~/components/sessions/SessionWarningDialog";
import { TemplateDraftDialog } from "~/components/templates/TemplateDraftDialog";
import { ViewDialog } from "~/components/views/ViewDialog";

/** App-level dialogs driven by useDialogs(). Mounted once at the root. */
export function AppDialogs() {
  return (
    <>
      <DigestDialog />
      <T3LaunchDialog />
      <SessionLaunchDialog />
      <PlanTasksDialog />
      <PlanSessionDialog />
      <MergePrDialog />
      <SessionWarningDialog />
      <TemplateDraftDialog />
      <ImagePreviewDialog />
      <ViewDialog />
    </>
  );
}
