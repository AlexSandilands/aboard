import { DesktopUpdateState, type DesktopBridge } from "@repo/contracts";
import { useEffect, useMemo, useState } from "react";
import { desktopBridge } from "~/lib/desktopBridge";

export interface DesktopUpdate {
  state: DesktopUpdateState;
  check: () => void;
  install: () => void;
  setAutoCheck: (enabled: boolean) => void;
  openReleaseNotes: () => void;
}

type UpdateBridge = Required<
  Pick<
    DesktopBridge,
    | "getUpdateState"
    | "onUpdateState"
    | "checkForUpdates"
    | "installUpdate"
    | "setAutoCheckUpdates"
    | "openReleaseNotes"
  >
>;

/** The shell's update methods, or null in a browser or a shell from before updates. */
function updateBridge(): UpdateBridge | null {
  const bridge = desktopBridge();
  if (!bridge?.getUpdateState || !bridge.onUpdateState || !bridge.checkForUpdates || !bridge.installUpdate) return null;
  if (!bridge.setAutoCheckUpdates || !bridge.openReleaseNotes) return null;
  return bridge as UpdateBridge;
}

/** Reads what the shell sent, so a shell newer or older than the page can't hand it a shape it doesn't know. */
function parse(value: unknown): DesktopUpdateState | null {
  const parsed = DesktopUpdateState.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The desktop app's update state and its actions, kept current as the shell reports changes. Null outside the desktop
 * shell, and until the shell has answered.
 */
export function useDesktopUpdate(): DesktopUpdate | null {
  const bridge = useMemo(() => updateBridge(), []);
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const unsubscribe = bridge.onUpdateState((next) => {
      const parsed = parse(next);
      if (parsed) setState(parsed);
    });
    const load = async () => {
      const parsed = parse(await bridge.getUpdateState());
      // A change pushed while the first answer was on its way is newer; keep it.
      if (live && parsed) setState((current) => current ?? parsed);
    };
    void load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);
  return useMemo(
    () =>
      bridge && state
        ? {
            state,
            check: () => bridge.checkForUpdates(),
            install: () => bridge.installUpdate(),
            setAutoCheck: (enabled) => {
              // The shell confirms with a new state; this makes the switch move straight away.
              setState((current) => (current ? { ...current, autoCheck: enabled } : current));
              bridge.setAutoCheckUpdates(enabled);
            },
            openReleaseNotes: () => bridge.openReleaseNotes(),
          }
        : null,
    [bridge, state],
  );
}
