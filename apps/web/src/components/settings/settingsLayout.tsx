// Adapted from T3 Code (apps/web/src/components/settings/SettingsGroup.tsx, settingsLayout.tsx), MIT — see NOTICE.
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/** Shared settings card surface, with separators between rows. */
export function SettingsGroup({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "relative overflow-visible rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none",
        className,
      )}
    />
  );
}

/** A titled group of settings rows. Muted headings have no descriptions; copy belongs to rows. */
export function SettingsSection({
  title,
  headerAction,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">{title}</h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

/**
 * One setting: title + description on the left, the control on the right (stacked on
 * narrow widths). `children` render full-width below, e.g. an inline folder browser.
 * Controls use `size="sm"` buttons/inputs/selects, per T3's settings tiers.
 */
export function SettingsRow({
  title,
  description,
  status,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      {...rowProps}
      data-slot="settings-row"
      className={cn("@container/settings-row rounded-xl px-3 sm:px-4", children ? "pt-3 pb-3" : "py-3", className)}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
          </div>
          {description ? <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">{description}</p> : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** Copies `text` and briefly shows a check. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => setCopied(true));
            }}
          >
            {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          </Button>
        }
      />
      <TooltipPopup side="top">{copied ? "Copied" : label}</TooltipPopup>
    </Tooltip>
  );
}

/** A monospace command line with a copy button, for setup snippets. */
export function CommandSnippet({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 py-1 ps-2.5 pe-1">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground/90">{command}</code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}
