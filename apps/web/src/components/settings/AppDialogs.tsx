import { ImagePreviewDialog } from "~/components/attachments/ImagePreviewDialog";
import { DigestDialog } from "~/components/digest/DigestDialog";
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
      <MergePrDialog />
      <SessionWarningDialog />
      <TemplateDraftDialog />
      <ImagePreviewDialog />
    </>
  );
}
