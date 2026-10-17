import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { attachmentSrc } from "~/lib/api";
import { useDialogs } from "~/state/ui";

/** A pasted image at full size, opened from a pill or a thumbnail. */
export function ImagePreviewDialog() {
  const image = useDialogs((s) => s.imagePreview);
  const close = useDialogs((s) => s.closeImagePreview);
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-5xl">
        {image ? (
          <>
            <DialogTitle className="sr-only">{image.filename}</DialogTitle>
            <img
              src={attachmentSrc(image.id)}
              alt={image.filename}
              className="max-h-[80vh] w-full rounded-lg object-contain"
            />
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
