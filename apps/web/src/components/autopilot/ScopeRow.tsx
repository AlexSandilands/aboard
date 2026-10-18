import type { AutopilotMode } from "@repo/contracts";
import { PauseIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type { ScopeRowModel } from "./autopilot.logic";

/** A muted label above a ScopeCard, for a group of rows that has no card of its own to say what it is. */
export function ScopeSectionLabel({ children }: { children: ReactNode }) {
  return <h4 className="px-0.5 text-2xs font-medium text-muted-foreground">{children}</h4>;
}

/** The frame every group of rows in the Autopilot popover shares (Orchestrate, the automations, an epic's delivery). */
export function ScopeCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col divide-y divide-border/50 rounded-lg border border-border/60 bg-card/40 px-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Stand-in rows while a scope loads, so no switch shows a made-up Off. */
export function ScopeSkeleton() {
  return (
    <ScopeCard>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex min-h-9 items-center justify-between gap-2 py-1">
          <Skeleton className="h-3 w-28" />
          <Skeleton shape="pill" className="h-4 w-7" />
        </div>
      ))}
    </ScopeCard>
  );
}

/** Pause all is set: one line, with Resume. */
export function PausedNotice({ onResume, disabled }: { onResume: () => void; disabled?: boolean }) {
  return (
    <Alert variant="warning" className="px-2.5 py-1.5 text-xs">
      <PauseIcon />
      <AlertDescription>Paused: no new runs start.</AlertDescription>
      <AlertAction>
        <Button size="compact" variant="warning-outline" disabled={disabled} onClick={onResume}>
          Resume
        </Button>
      </AlertAction>
    </Alert>
  );
}

/**
 * One automation at a project or epic: its name (the description is its tooltip) and an on/off switch. The switch is
 * faded while it follows the scope above and solid once this scope sets it, which also shows ↺ to follow again. The
 * stored Inherit / On / Off model is unchanged: a click saves an explicit On or Off, ↺ saves Inherit.
 */
export function ScopeRow({
  name,
  description,
  label,
  model,
  scope,
  disabled,
  onChange,
  trailing,
}: {
  name: string;
  description: string;
  /** The switch's accessible name, e.g. "Review PRs in Aboard"; where its state comes from is added to it. */
  label: string;
  model: ScopeRowModel;
  scope: "project" | "epic";
  disabled?: boolean;
  onChange: (mode: AutopilotMode) => void;
  /** Icon buttons after the name, such as a link to the automation's own page. */
  trailing?: ReactNode;
}) {
  const parent = scope === "epic" ? "project" : "board";
  return (
    <div className="flex min-h-9 items-center gap-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate text-xs font-medium" />}>{name}</TooltipTrigger>
          <TooltipPopup side="top">{description}</TooltipPopup>
        </Tooltip>
        {model.blocked ? (
          <Tooltip>
            <TooltipTrigger render={<span role="img" aria-label={`${name} can't be turned on`} className="shrink-0" />}>
              <TriangleAlertIcon className="size-3.5 text-warning" />
            </TooltipTrigger>
            <TooltipPopup side="top">{model.blocked}</TooltipPopup>
          </Tooltip>
        ) : null}
        {trailing}
      </div>
      {model.inherited ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                aria-label={`Reset ${name} to follow the ${parent}`}
                disabled={disabled}
                onClick={() => onChange("inherit")}
              />
            }
          >
            <Undo2Icon />
          </TooltipTrigger>
          <TooltipPopup side="top">Follow the {parent} again</TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger render={<span className={cn("inline-flex", model.inherited && "opacity-55")} />}>
          <Switch
            size="sm"
            aria-label={`${label}: ${model.note}`}
            checked={model.checked}
            disabled={disabled || !model.canToggle}
            onCheckedChange={() => onChange(model.nextMode)}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{model.note}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
