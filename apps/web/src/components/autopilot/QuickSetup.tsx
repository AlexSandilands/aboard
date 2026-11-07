// Quick setup: pick Notify, Assist or Hands-off, read exactly what it would switch on, and apply it once. It stores no
// level: the writes are ordinary board switches, so the next look at Autopilot shows them like any others.
import {
  QUICK_SETUP_LEVELS,
  QUICK_SETUP_PRESETS,
  quickSetupChanges,
  quickSetupSummary,
  quickSetupWrites,
  type QuickSetupChange,
  type QuickSetupInput,
  type QuickSetupLevel,
} from "@repo/contracts";
import { CheckIcon, MinusIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useApplyQuickSetup } from "~/state/mutations";

/** What Quick setup reads: the catalogue and the switches now, without the Preview choice it holds itself. */
export type QuickSetupState = Omit<QuickSetupInput, "preview">;

export function QuickSetup({
  state,
  title = "Pick how much Autopilot does",
  onApplied,
}: {
  state: QuickSetupState;
  title?: string;
  /** After a successful Apply, so a dialog around it can close. */
  onApplied?: () => void;
}) {
  const [level, setLevel] = useState<QuickSetupLevel | null>(null);
  const [preview, setPreview] = useState(true);
  const apply = useApplyQuickSetup();
  const changes = level ? quickSetupChanges(level, { ...state, preview }) : [];
  const writes = quickSetupWrites(changes);
  const onApply = () => {
    if (!level) return;
    const summary = quickSetupSummary(level, changes);
    apply.mutate(writes, {
      onSuccess: () => {
        toastManager.add({
          type: "success",
          title: summary,
          description: "Quick setup doesn't remember this choice: change any automation as usual.",
        });
        setLevel(null);
        onApplied?.();
      },
    });
  };

  return (
    <div className="@container space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          It switches the matching automations on, once, for the whole board. Nothing remembers the choice.
        </p>
      </div>
      <div role="group" aria-label="Quick setup level" className="grid gap-2 @min-[28rem]:grid-cols-3">
        {QUICK_SETUP_LEVELS.map((value) => {
          const preset = QUICK_SETUP_PRESETS[value];
          const picked = value === level;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={picked}
              className={cn(
                "flex cursor-pointer flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                picked
                  ? "border-foreground/40 bg-accent/50"
                  : "border-border/60 hover:border-border hover:bg-accent/30",
              )}
              onClick={() => setLevel(picked ? null : value)}
            >
              <span className="text-sm font-medium text-foreground">{preset.label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{preset.blurb}</span>
            </button>
          );
        })}
      </div>
      {level ? (
        <>
          <ul
            aria-label={`What ${QUICK_SETUP_PRESETS[level].label} switches on`}
            className="divide-y divide-border/50 rounded-lg border border-border/60"
          >
            {changes.map((change) => (
              <ChangeRow key={change.automation} change={change} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Label className="min-w-0 flex-1 cursor-pointer text-xs font-normal text-muted-foreground sm:text-xs">
              <Switch size="sm" checked={preview} onCheckedChange={setPreview} />
              <span>Start agent automations in Preview (recommended): they record what they would do first.</span>
            </Label>
            <div className="ms-auto flex items-center gap-1">
              <Button size="sm" variant="ghost-muted" onClick={() => setLevel(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={apply.isPending || writes.length === 0} onClick={onApply}>
                {writes.length === 0 ? "Nothing to switch on" : `Apply ${QUICK_SETUP_PRESETS[level].label}`}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One line of the list: the automation, what it does, and what happens to it. */
function ChangeRow({ change }: { change: QuickSetupChange }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <span className="mt-0.5 shrink-0 text-muted-foreground">
        {change.kind === "switch_on" ? (
          <CheckIcon aria-hidden className="size-4" />
        ) : (
          <MinusIcon aria-hidden className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{change.title}</span>
        <span className="block text-xs text-muted-foreground">{noteOf(change)}</span>
      </span>
      <ChangeBadge change={change} />
    </li>
  );
}

function noteOf(change: QuickSetupChange): string {
  switch (change.kind) {
    case "switch_on":
      return change.overriddenIn.length > 0
        ? `${change.detail} Stays off in ${change.overriddenIn.join(", ")}, which switch it off themselves.`
        : change.detail;
    case "already_on":
      return `${change.detail} Already ${change.mode === "preview" ? "in Preview" : "on"}: left as it is.`;
    case "blocked":
      return `${change.detail} Can't be switched on yet: ${change.reason}`;
  }
}

function ChangeBadge({ change }: { change: QuickSetupChange }) {
  if (change.kind === "blocked") {
    return (
      <Badge variant="outline" size="sm">
        Blocked
      </Badge>
    );
  }
  const mode = change.mode;
  const already = change.kind === "already_on";
  return (
    <Badge variant={mode === "preview" ? "warning" : already ? "outline" : "success"} size="sm">
      {already ? `Already ${mode === "preview" ? "Preview" : "on"}` : mode === "preview" ? "Preview" : "On"}
    </Badge>
  );
}
