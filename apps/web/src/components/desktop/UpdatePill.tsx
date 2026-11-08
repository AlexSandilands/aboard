import { RocketIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useDesktopUpdate } from "./useDesktopUpdate";

/** Room the pill takes from the top bars, which add it to their inset past the native window controls. */
const SPACE_VAR = "--title-bar-pill-space";

/**
 * "Restart to update" in the desktop title bar, beside the native window controls, while a downloaded update waits.
 * It sits over every page's top bar at once; the bars make room through `--title-bar-pill-space` (index.css).
 */
export function UpdatePill() {
  const update = useDesktopUpdate();
  const ref = useRef<HTMLButtonElement>(null);
  const shown = update !== null && (update.state.status === "ready" || update.state.status === "installing");

  useEffect(() => {
    const pill = ref.current;
    if (!shown || !pill) return;
    const root = document.documentElement;
    // The gap to the next control (0.5rem) is part of the room it takes.
    const measure = () => root.style.setProperty(SPACE_VAR, `calc(${pill.offsetWidth}px + 0.5rem)`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    return () => {
      observer.disconnect();
      root.style.removeProperty(SPACE_VAR);
    };
  }, [shown]);

  if (!update || !shown) return null;
  const installing = update.state.status === "installing";
  return (
    <div className="pointer-events-none fixed top-[env(titlebar-area-y,0px)] right-(--workspace-native-controls-width) z-50 hidden h-(--workspace-topbar-height) items-center pe-3 wco:flex">
      <button
        ref={ref}
        type="button"
        disabled={installing}
        title={`v${update.state.version} is downloaded`}
        onClick={update.install}
        className="pointer-events-auto [-webkit-app-region:no-drag] inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full bg-primary px-2.5 text-xs font-medium text-primary-foreground shadow-xs outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-70"
      >
        <RocketIcon className="size-3.5" />
        {installing ? "Restarting…" : "Restart to update"}
      </button>
    </div>
  );
}
