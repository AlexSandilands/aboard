import { useEffect, useState, type FormEvent } from "react";
import { useBoardFilterParams } from "~/components/board/boardNavigation";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { useDialogs } from "~/state/ui";
import { useSavedViews, useViewActions } from "~/state/views";
import { viewNameError } from "./views.logic";

/** Names a new saved view (the board's filters as they are now), or renames one. Opened by `useDialogs`. */
export function ViewDialog() {
  const dialog = useDialogs((s) => s.viewDialog);
  const close = useDialogs((s) => s.closeViewDialog);
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-md">{dialog ? <ViewForm dialog={dialog} onDone={close} /> : null}</DialogPopup>
    </Dialog>
  );
}

function ViewForm({
  dialog,
  onDone,
}: {
  dialog: NonNullable<ReturnType<typeof useDialogs.getState>["viewDialog"]>;
  onDone: () => void;
}) {
  const views = useSavedViews();
  const params = useBoardFilterParams();
  const actions = useViewActions();
  const renaming = dialog.kind === "rename" ? views.find((v) => v.id === dialog.viewId) : undefined;
  const [name, setName] = useState(renaming?.name ?? "");
  // The view may be deleted while its dialog is open (another browser).
  useEffect(() => {
    if (dialog.kind === "rename" && !renaming) onDone();
  }, [dialog.kind, renaming, onDone]);
  const error = name.trim() ? viewNameError(views, name, renaming?.id) : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (viewNameError(views, name, renaming?.id)) return;
    const done = () => {
      onDone();
      toastManager.add({ type: "success", title: renaming ? "View renamed" : "View saved" });
    };
    if (renaming) actions.rename(renaming.id, name, done);
    else actions.save(name, params, done);
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>{renaming ? "Rename view" : "Save view"}</DialogTitle>
        <DialogDescription>
          {renaming
            ? "Only the name changes."
            : "Saves the board's filters as they are now. Pick the view in the sidebar to bring them back."}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Input
          autoFocus
          nativeInput
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          placeholder="Name"
          aria-label="View name"
          aria-invalid={error !== null}
        />
        {error ? <p className="mt-1.5 text-xs text-destructive-foreground">{error}</p> : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={actions.pending || !name.trim() || error !== null}>
          {renaming ? "Rename" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
