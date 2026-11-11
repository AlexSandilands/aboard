// Adapted from T3 Code (apps/web/src/components/AppRouteModal.tsx), MIT — see NOTICE.
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { DialogBackdrop } from "~/components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/** Closes the window that is open, set while one is mounted. */
let closeOpenWindow: (() => void) | null = null;

/**
 * Closes the open window the way its close button does: fields commit, it animates out, then `onClosed` runs.
 * False when no window is open.
 */
export function closeAppWindow(): boolean {
  if (!closeOpenWindow) return false;
  closeOpenWindow();
  return true;
}

/**
 * A large floating window over the board, for a route that renders inside it (Settings, Stats). The close button,
 * a press on the backdrop or `closeAppWindow()` closes it, and `onClosed` then leaves the route. Full screen below
 * `sm`.
 *
 * Escape is not the dialog's: the `back` shortcut closes the window (`AppFrame`), so it can be rebound and yields to
 * whatever nearer the focus claims the key, as it does everywhere else. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because the pages inside own their shortcuts.
 */
export function AppRouteModal({
  label,
  onClosed,
  className,
  children,
}: {
  label: string;
  /** Runs once the window has closed (after its animation): navigate away here. */
  onClosed: () => void;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  // Text selection that ends on the backdrop is not a dismissal.
  const backdropPress = useRef(false);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, leave focus alone; returning it to the opener paints a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);

  const close = () => {
    // Closing unmounts a focused field without a blur, so commit-on-blur rows would drop what was typed.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
    setOpen(false);
  };

  useEffect(() => {
    closeOpenWindow = close;
    return () => {
      if (closeOpenWindow === close) closeOpenWindow = null;
    };
  });

  return (
    <DialogPrimitive.Root
      open={open}
      // Portaled layers outside this tree (toasts, the palette, confirm dialogs) are not backdrop presses.
      disablePointerDismissal
      onOpenChange={(nextOpen, details) => {
        if (nextOpen) return;
        if (details.reason === "escape-key") {
          // Left unhandled (no preventDefault), so the `back` shortcut decides.
          details.cancel();
          return;
        }
        close();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClosed();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogBackdrop className={NO_MOTION} />
        <DialogPrimitive.Viewport
          // In the desktop shell the window starts below the title bar overlay, clear of the native controls.
          className="fixed inset-0 z-50 flex items-center justify-center sm:p-6 sm:wco:pt-[max(var(--workspace-topbar-height),1.5rem)] lg:p-10 lg:wco:pt-[max(var(--workspace-topbar-height),2.5rem)]"
          onPointerDown={(event) => {
            backdropPress.current = event.target === event.currentTarget;
          }}
          onClick={(event) => {
            if (backdropPress.current && event.target === event.currentTarget) close();
            backdropPress.current = false;
          }}
        >
          <DialogPrimitive.Popup
            ref={popupRef}
            initialFocus={popupRef}
            finalFocus={false}
            aria-label={label}
            data-slot="dialog-popup"
            data-app-modal=""
            className={cn(
              "relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground outline-none transition-[opacity,scale] duration-150 ease-out [-webkit-app-region:no-drag] data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-starting-style:scale-[0.985] data-starting-style:opacity-0 sm:max-h-[60rem] sm:max-w-[80rem] sm:rounded-2xl sm:border sm:shadow-2xl/40",
              NO_MOTION,
              className,
            )}
          >
            {children}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * The window appears and goes in place unless Panel animations is on: `data-panel-animations` on <html> already
 * has the setting and reduced motion resolved (theme/appearance.ts).
 */
const NO_MOTION = "[html:not([data-panel-animations=true])_&]:transition-none";

/**
 * A window's header row. Full screen in the desktop shell (below `sm`), it pads past the native window controls.
 */
export const APP_WINDOW_HEADER_CLASS =
  "flex h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2 max-sm:ps-4 max-sm:wco:pe-(--workspace-native-controls-inset)";

/** The window's close button, for the end of its header. */
export function AppRouteModalClose({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label="Close"
            className={className}
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
    </Tooltip>
  );
}
