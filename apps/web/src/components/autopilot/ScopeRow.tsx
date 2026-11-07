import { PauseIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

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
 * One automation at a project or epic: its name (the description is its tooltip), a muted line saying where it runs
 * overall ("On everywhere except storefront") and an on/off switch for this scope. The switch always shows what the
 * automation does here; the stored Inherit / On / Off is chosen for it (see `scopeToggle`), so there is nothing to
 * reset.
 */
export function ScopeRow({
  name,
  description,
  label,
  checked,
  where,
  blocked,
  disabled,
  onChange,
  trailing,
}: {
  name: string;
  description: string;
  /** The switch's accessible name, e.g. "Review PRs in Aboard". */
  label: string;
  checked: boolean;
  /** Where it runs overall, under the name. */
  where?: string;
  /** Why it can't be turned on (an empty required tool slot); turning off still works. */
  blocked: string | null;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  /** Icon buttons after the name, such as a link to the automation's own page. */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center gap-2 py-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 truncate text-xs font-medium" />}>{name}</TooltipTrigger>
            <TooltipPopup side="top">{description}</TooltipPopup>
          </Tooltip>
          {blocked ? (
            <Tooltip>
              <TooltipTrigger
                render={<span role="img" aria-label={`${name} can't be turned on`} className="shrink-0" />}
              >
                <TriangleAlertIcon className="size-3.5 text-warning" />
              </TooltipTrigger>
              <TooltipPopup side="top">{blocked}</TooltipPopup>
            </Tooltip>
          ) : null}
          {trailing}
        </div>
        {where ? <span className="truncate text-2xs text-muted-foreground">{where}</span> : null}
      </div>
      <Switch
        size="sm"
        aria-label={where ? `${label}: ${where}` : label}
        checked={checked}
        disabled={disabled || (!checked && Boolean(blocked))}
        onCheckedChange={onChange}
      />
    </div>
  );
}
