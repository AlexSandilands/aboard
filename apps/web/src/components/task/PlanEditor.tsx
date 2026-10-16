import { parsePlanMarkdown, type PlanInput, type TaskDetail } from "@repo/contracts";
import { PlusIcon, Trash2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useSetPlan } from "~/state/mutations";
import {
  nextOutlineKey,
  outlineFromPhases,
  outlineFromPlanInput,
  planInputFromOutline,
  type OutlinePhase,
} from "./plan.logic";
import { StepStatusGlyph } from "./StepVisuals";

export type PlanEditorMode = "paste" | "outline";

const PASTE_PLACEHOLDER = `## Phase 1: Groundwork
- [x] Spike the approach
- [ ] Write migrations
  Notes under an item become the step's notes.

## Phase 2: Ship
- [ ] Wire up the UI
- [ ] Release`;

/**
 * Write or replace a task's plan, either by pasting markdown (parsed live with
 * parsePlanMarkdown) or in a minimal outline editor. `session` remounts the body so each
 * opening starts fresh.
 */
export function PlanEditor({
  task,
  open,
  onOpenChange,
  mode,
  session,
}: {
  task: TaskDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: PlanEditorMode;
  session: number;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <PlanEditorBody key={session} task={task} initialMode={mode} onDone={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

function emptyOutline(): OutlinePhase[] {
  return [{ key: nextOutlineKey(), title: "Plan", steps: [{ key: nextOutlineKey(), title: "" }] }];
}

function PlanEditorBody({
  task,
  initialMode,
  onDone,
}: {
  task: TaskDetail;
  initialMode: PlanEditorMode;
  onDone: () => void;
}) {
  const hasPlan = task.phases.some((p) => p.steps.length > 0);
  const [mode, setMode] = useState(initialMode);
  const [text, setText] = useState("");
  const [outline, setOutline] = useState<OutlinePhase[]>(() =>
    hasPlan ? outlineFromPhases(task.phases) : emptyOutline(),
  );
  const parsed = useMemo(() => (text.trim() ? parsePlanMarkdown(text) : null), [text]);
  const setPlan = useSetPlan();

  const plan: PlanInput | null = mode === "paste" ? parsed : planInputFromOutline(outline);

  const switchMode = (next: PlanEditorMode) => {
    if (next === mode) return;
    // Carry pasted text into the outline so it can be tidied before saving.
    if (next === "outline" && parsed) setOutline(outlineFromPlanInput(parsed));
    setMode(next);
  };

  const save = () => {
    if (!plan) return;
    setPlan.mutate({ taskId: task.id, plan }, { onSuccess: onDone });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{hasPlan ? "Edit plan" : "Write a plan"}</DialogTitle>
        <DialogDescription>Phases hold ordered steps. Agents update each step's status as they work.</DialogDescription>
        <ToggleGroup
          className="mt-2"
          value={[mode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "paste" || next === "outline") switchMode(next);
          }}
        >
          <Toggle value="paste">Paste markdown</Toggle>
          <Toggle value="outline">Outline</Toggle>
        </ToggleGroup>
      </DialogHeader>
      <DialogPanel>
        {mode === "paste" ? (
          <>
            {hasPlan ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>
                  Saving replaces the current plan. Progress on existing steps isn't kept for pasted steps.
                </AlertDescription>
              </Alert>
            ) : null}
            <Textarea
              autoFocus
              aria-label="Plan markdown"
              value={text}
              placeholder={PASTE_PLACEHOLDER}
              onChange={(event) => setText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  save();
                }
              }}
            />
            <div>
              <div className="mb-1.5 text-2xs font-medium text-muted-foreground">Preview</div>
              {!text.trim() ? (
                <p className="text-xs text-muted-foreground">
                  Use <code className="font-mono">## headings</code> for phases and{" "}
                  <code className="font-mono">- [ ]</code> list items for steps. <code className="font-mono">[x]</code>{" "}
                  marks a step done.
                </p>
              ) : parsed ? (
                <PlanPreview plan={parsed} />
              ) : (
                <p className="text-xs text-destructive-foreground">No steps found</p>
              )}
            </div>
          </>
        ) : (
          <OutlineEditor outline={outline} onChange={setOutline} />
        )}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
        <Button disabled={!plan || setPlan.isPending} onClick={save}>
          {hasPlan ? "Save plan" : "Create plan"}
        </Button>
      </DialogFooter>
    </>
  );
}

function PlanPreview({ plan }: { plan: PlanInput }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-3">
      {plan.context ? <p className="line-clamp-2 text-xs text-muted-foreground">{plan.context}</p> : null}
      {plan.phases.map((phase, pi) => (
        // oxlint-disable-next-line react/no-array-index-key -- read-only preview of a parsed draft; items have no ids
        <div key={pi}>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground/85">
            <span className="font-mono text-2xs text-muted-foreground/60 tabular-nums">{pi + 1}</span>
            {phase.title}
          </div>
          <ol className="mt-1 flex flex-col gap-1 ps-4">
            {phase.steps.map((step, si) => (
              // oxlint-disable-next-line react/no-array-index-key -- read-only preview of a parsed draft; items have no ids
              <li key={si} className="flex items-start gap-2">
                <span className="flex h-5 shrink-0 items-center">
                  <StepStatusGlyph status={step.status ?? "todo"} size="sm" />
                </span>
                <span className="min-w-0 text-[13px] leading-5 text-foreground/80 wrap-anywhere">
                  {step.title}
                  {step.notes ? <span className="ms-1.5 text-2xs text-muted-foreground">+ notes</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

export function OutlineEditor({
  outline,
  onChange,
}: {
  outline: OutlinePhase[];
  onChange: (next: OutlinePhase[]) => void;
}) {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const updatePhase = (key: string, fn: (phase: OutlinePhase) => OutlinePhase) =>
    onChange(outline.map((phase) => (phase.key === key ? fn(phase) : phase)));
  const addStep = (phaseKey: string, afterIndex?: number) => {
    const key = nextOutlineKey();
    updatePhase(phaseKey, (phase) => {
      const steps = [...phase.steps];
      steps.splice(afterIndex === undefined ? steps.length : afterIndex + 1, 0, { key, title: "" });
      return { ...phase, steps };
    });
    setFocusKey(key);
  };

  return (
    <div className="flex flex-col gap-3">
      {outline.map((phase, pi) => (
        <div key={phase.key} className="rounded-xl border border-border/60 bg-card/40 p-2">
          <div className="flex items-center gap-1.5">
            <span className="w-5 shrink-0 text-center font-mono text-2xs text-muted-foreground/60 tabular-nums">
              {pi + 1}
            </span>
            <Input
              aria-label={`Phase ${pi + 1} title`}
              size="sm"
              value={phase.title}
              placeholder={`Phase ${pi + 1}`}
              onChange={(event) => {
                const title = event.currentTarget.value;
                updatePhase(phase.key, (p) => ({ ...p, title }));
              }}
            />
            <Button
              variant="ghost-destructive"
              size="icon-xs"
              aria-label={`Remove phase ${pi + 1}`}
              onClick={() => onChange(outline.filter((p) => p.key !== phase.key))}
            >
              <Trash2Icon />
            </Button>
          </div>
          <ol className="mt-1.5 flex flex-col gap-1">
            {phase.steps.map((step, si) => (
              <li key={step.key} className="flex items-center gap-1.5">
                <span className="flex w-5 shrink-0 justify-center">
                  <StepStatusGlyph status={step.status ?? "todo"} size="sm" />
                </span>
                <Input
                  autoFocus={step.key === focusKey}
                  aria-label={`Step ${pi + 1}.${si + 1}`}
                  size="sm"
                  value={step.title}
                  placeholder="Step"
                  onChange={(event) => {
                    const title = event.currentTarget.value;
                    updatePhase(phase.key, (p) => ({
                      ...p,
                      steps: p.steps.map((s) => (s.key === step.key ? { ...s, title } : s)),
                    }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      addStep(phase.key, si);
                    }
                  }}
                />
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label={`Remove step ${pi + 1}.${si + 1}`}
                  onClick={() =>
                    updatePhase(phase.key, (p) => ({ ...p, steps: p.steps.filter((s) => s.key !== step.key) }))
                  }
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ol>
          <Button className="mt-1 ms-5" variant="ghost-muted" size="xs" onClick={() => addStep(phase.key)}>
            <PlusIcon />
            Add step
          </Button>
        </div>
      ))}
      <Button
        className="self-start"
        variant="outline"
        size="sm"
        onClick={() => {
          const stepKey = nextOutlineKey();
          onChange([...outline, { key: nextOutlineKey(), title: "", steps: [{ key: stepKey, title: "" }] }]);
          setFocusKey(stepKey);
        }}
      >
        <PlusIcon />
        Add phase
      </Button>
    </div>
  );
}
