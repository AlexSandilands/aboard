// Adapted from T3 Code (apps/web/src/components/settings/SettingsGroup.tsx, settingsLayout.tsx,
// FoldedSettingsSection.tsx), MIT — see NOTICE.
import { CheckIcon, ChevronRightIcon, CopyIcon, InfoIcon, Undo2Icon } from "lucide-react";
import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useSettingsNav } from "~/state/ui";
import { useOpenSettings } from "./settingsNavigation";

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

/**
 * One entry of the settings list: the anchor its link scrolls to and scroll-spy watches. `id` is the section's
 * stable id from `SETTINGS_GROUPS`. Holds one or more `SettingsSection`s.
 */
export function SettingsSubsection({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} data-settings-section={id} className="scroll-mt-4 space-y-6">
      {children}
    </div>
  );
}

export type StatusTone = "success" | "warning" | "muted";

const DOT_TONES: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  muted: "bg-muted-foreground/40",
};

/** A small coloured dot for an integration's state; `label` is read out and shown on hover. */
export function StatusDot({ tone, label, className }: { tone: StatusTone; label: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_TONES[tone], className)}
    />
  );
}

/**
 * Detail that matters but would crowd a row (setup steps, how something is matched), behind an info button next to
 * the row's title. Opens on hover, and on click or Enter, so it works from the keyboard and on touch.
 */
export function InfoHover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        aria-label={label}
        className="inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup side="top" className="max-w-80 text-xs leading-relaxed">
        {children}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * A row's status details on one compact line under its title: an optional badge, then the detail (a version, a path,
 * a scope). Long text wraps inside the line instead of pushing the control.
 */
export function StatusLine({ badge, children }: { badge?: ReactNode; children?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 break-words">
      {badge}
      {children ? <span className="min-w-0 break-all">{children}</span> : null}
    </span>
  );
}

/** A titled group of settings rows. Muted headings have no descriptions; copy belongs to rows. */
export function SettingsSection({
  id,
  title,
  status,
  headerAction,
  children,
}: {
  /** A stable id (`<group>.<section>.<part>`) when the group is a target of its own. */
  id?: string;
  title: string;
  /** Shown before the title, e.g. a StatusDot. */
  status?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-4 space-y-2.5">
      <div className="flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70">
          {status}
          {title}
        </h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

/**
 * One setting: title + one short description on the left, the control on the right (stacked on
 * narrow widths). Detail that matters goes in `info` (an info button beside the title) and status
 * details in `status` (a compact line under the description). `children` render full-width below,
 * e.g. an inline folder browser.
 * Controls use `size="sm"` buttons/inputs/selects, per T3's settings tiers.
 */
export function SettingsRow({
  title,
  description,
  info,
  infoLabel,
  status,
  control,
  resetAction,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  /** Longer detail shown in an info popover beside the title. */
  info?: ReactNode;
  /** The info button's accessible name; defaults to "More about <title>" for a string title. */
  infoLabel?: string;
  status?: ReactNode;
  control?: ReactNode;
  /** A SettingResetButton beside the title, shown while the setting differs from its default. */
  resetAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      {...rowProps}
      data-slot="settings-row"
      className={cn(
        "@container/settings-row scroll-mt-4 rounded-xl px-3 sm:px-4",
        children ? "pt-3 pb-3" : "py-3",
        className,
      )}
    >
      <div className="flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            {info ? (
              <InfoHover label={infoLabel ?? (typeof title === "string" ? `More about ${title}` : "More info")}>
                {info}
              </InfoHover>
            ) : null}
            {resetAction ? (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{resetAction}</span>
            ) : null}
          </div>
          {description ? (
            <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">{description}</p>
          ) : null}
          {status ? <div className="min-w-0 pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
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

/** Puts a setting back to its default; sits beside a row's title (SettingsRow's `resetAction`). */
export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Reset ${label} to default`}
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A grouped section that starts closed: the title and a one-line summary in the header, with an optional control
 * (such as the section's own switch) beside it. Opens when it is the target of a settings link.
 */
export function FoldedSettingsSection({
  id,
  title,
  summary,
  control,
  children,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
  control?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const target = useSettingsNav((s) => s.scrollTarget);
  // A link to the section (or a row in it) lands inside the fold, so open it before the scroll runs.
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  if (target && target.nonce !== openedFor && (target.id === id || target.id.startsWith(`${id}.`))) {
    setOpenedFor(target.nonce);
    if (!open) setOpen(true);
  }
  return (
    <section id={id} className="scroll-mt-4">
      <Collapsible open={open} onOpenChange={setOpen} render={<SettingsGroup />}>
        <div className="flex items-center gap-4 px-3 sm:px-4">
          <CollapsibleTrigger className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium">{title}</span>
            {summary ? <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span> : null}
          </CollapsibleTrigger>
          {control ? <div className="flex shrink-0 items-center">{control}</div> : null}
        </div>
        <CollapsiblePanel>
          <div className="[&>*+*]:border-t [&>*+*]:border-border/50">{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

/** An inline link to another setting: a group, section or row id (see `useOpenSettings`). */
export function SettingsLink({ to, project, children }: { to: string; project?: string; children: ReactNode }) {
  const openSettings = useOpenSettings();
  return (
    <button
      type="button"
      className="cursor-pointer rounded-sm text-foreground/80 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => openSettings(to, project ? { project } : {})}
    >
      {children}
    </button>
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
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-foreground/90">
        {command}
      </code>
      <CopyButton text={command} label="Copy command" />
    </div>
  );
}
