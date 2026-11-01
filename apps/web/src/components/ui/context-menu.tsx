"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "~/lib/utils";
import { MENU_POPUP_CLASS } from "./menu";

// The right-click menu. Items, separators and submenus are the Menu ones (see menu.tsx): Base UI shares them.

const ContextMenu = ContextMenuPrimitive.Root;

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger className={className} data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuPopup({
  children,
  className,
  ...props
}: ContextMenuPrimitive.Popup.Props & { className?: string }) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-[130]" data-slot="context-menu-positioner">
        <ContextMenuPrimitive.Popup className={cn(MENU_POPUP_CLASS, className)} data-slot="menu-popup" {...props}>
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export { ContextMenu, ContextMenuPopup, ContextMenuTrigger };
