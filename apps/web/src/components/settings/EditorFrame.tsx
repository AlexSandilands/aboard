import { createContext, type ComponentProps, type ReactNode, useContext } from "react";
import { DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

/**
 * The editors (templates, custom automations, recurring rules) render the same body in a dialog or on a settings
 * sub-page. These parts are the dialog's by default and plain page blocks inside `EditorPage`.
 */
const InPage = createContext(false);

export function EditorPage({ children }: { children: ReactNode }) {
  return <InPage value>{children}</InPage>;
}

export function EditorHeader({ className, ...props }: ComponentProps<"div">) {
  if (!useContext(InPage)) return <DialogHeader className={className} {...props} />;
  return <div className={cn("flex flex-col gap-2 px-3 pb-4 sm:px-4", className)} {...props} />;
}

export function EditorTitle({ children }: { children: ReactNode }) {
  if (!useContext(InPage)) return <DialogTitle>{children}</DialogTitle>;
  return <h1 className="font-semibold text-xl leading-none">{children}</h1>;
}

export function EditorPanel({ className, ...props }: ComponentProps<"div">) {
  if (!useContext(InPage)) return <DialogPanel className={className} {...props} />;
  return (
    <div
      className={cn("space-y-4 rounded-xl border border-border/60 bg-card/40 p-4 shadow-xs/5", className)}
      {...props}
    />
  );
}

export function EditorFooter({ className, ...props }: ComponentProps<"div">) {
  if (!useContext(InPage)) return <DialogFooter className={className} {...props} />;
  return <div className={cn("flex flex-col-reverse gap-2 pt-4 sm:flex-row sm:justify-end", className)} {...props} />;
}
