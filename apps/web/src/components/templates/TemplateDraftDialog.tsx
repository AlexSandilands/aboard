import { Dialog, DialogPopup } from "~/components/ui/dialog";
import { toastManager } from "~/components/ui/toast";
import { useDialogs } from "~/state/ui";
import { TemplateEditorForm } from "./TemplateEditorForm";
import { formFromDraft } from "./templates.logic";

/** The template editor outside Settings: opened with a draft, e.g. by "Save as template" on a task. */
export function TemplateDraftDialog() {
  const draft = useDialogs((s) => s.templateDraft);
  const close = useDialogs((s) => s.closeTemplateDraft);
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-2xl">
        {draft ? (
          <TemplateEditorForm
            templateId={null}
            initial={formFromDraft(draft)}
            onCancel={close}
            onDone={() => {
              close();
              toastManager.add({
                type: "success",
                title: "Template saved",
                description: "Pick it from New task, or manage it in Settings.",
              });
            }}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
