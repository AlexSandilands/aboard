import { DesktopWhatsNew } from "@repo/contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { desktopBridge } from "~/lib/desktopBridge";
import { useDialogs } from "~/state/ui";
import { releaseNotesBridge, type ReleaseNotesBridge } from "./releaseNotes.logic";

/** What the shell said about release notes, shared by the dialog and the Settings switch. */
const useWhatsNewStore = create<{ whatsNew: DesktopWhatsNew | null }>()(() => ({ whatsNew: null }));

/** The shell is asked once per page load; the answer stays in the store. */
let asked = false;
/** The dialog opens by itself at most once per page load. */
let openedPending = false;

export interface ReleaseNotes {
  bridge: ReleaseNotesBridge;
  whatsNew: DesktopWhatsNew;
  setShowReleaseNotes: (enabled: boolean) => void;
}

/**
 * The desktop app's release notes: whether they show after updates, and the shell's methods. Null outside the desktop
 * shell, in a shell from before release notes, and until the shell has answered. With `openPending` (the host only),
 * it opens the dialog once the shell says this launch is the first after an update.
 */
export function useReleaseNotes(openPending = false): ReleaseNotes | null {
  const bridge = useMemo(() => releaseNotesBridge(desktopBridge()), []);
  const whatsNew = useWhatsNewStore((s) => s.whatsNew);
  useEffect(() => {
    if (!bridge || asked) return;
    asked = true;
    const load = async () => {
      let value: unknown;
      try {
        value = await bridge.getWhatsNew();
      } catch {
        // Ask again on the next mount.
        asked = false;
        return;
      }
      const parsed = DesktopWhatsNew.safeParse(value);
      if (parsed.success) useWhatsNewStore.setState({ whatsNew: parsed.data });
    };
    void load();
  }, [bridge]);
  // Whichever caller asked first, only the host opens the dialog.
  useEffect(() => {
    if (!openPending || openedPending || !whatsNew) return;
    openedPending = true;
    const { since, showReleaseNotes } = whatsNew;
    if (since !== null && showReleaseNotes && !useDialogs.getState().releaseNotes) {
      useDialogs.getState().openReleaseNotes({ mode: "update", since });
    }
  }, [openPending, whatsNew]);
  return useMemo(
    () =>
      bridge && whatsNew
        ? {
            bridge,
            whatsNew,
            setShowReleaseNotes: (enabled) => {
              useWhatsNewStore.setState((state) =>
                state.whatsNew ? { whatsNew: { ...state.whatsNew, showReleaseNotes: enabled } } : state,
              );
              bridge.setShowReleaseNotes(enabled);
            },
          }
        : null,
    [bridge, whatsNew],
  );
}
