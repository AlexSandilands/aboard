import {
  defaultHandoffMode,
  taskHandoffPrompt,
  type T3LaunchOptions,
  type T3LaunchSuggestion,
  type T3ModelSelection,
  type TaskSummary,
} from "@repo/contracts";
import { AlertCircleIcon, ArrowUpIcon, LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { ApiError } from "~/lib/api";
import { cn } from "~/lib/utils";
import { useStartT3Thread } from "~/state/mutations";
import { useBoard, useSettings, useT3LaunchOptions } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import {
  clampRuntimeMode,
  keepsCommandId,
  findModel,
  initialWorkspaceChoice,
  launchModelSelection,
  selectionAfterPlanToggle,
  toLaunchWorkspace,
  type WorkspaceChoice,
} from "./handoff.logic";
import { copyHandoffPrompt } from "./HandoffActions";
import { AccessPicker, ComposerControl, ModelPicker, RefPicker, TraitsPicker, WorkspaceMenu } from "./T3LaunchPickers";

/** "Start in T3 Code": a new-thread composer for a task, driven by useDialogs().openT3Launch(taskId). */
export function T3LaunchDialog() {
  const taskId = useDialogs((s) => s.t3LaunchTaskId);
  const close = useDialogs((s) => s.closeT3Launch);
  const task = useBoard().data?.tasks.find((t) => t.id === taskId);
  return (
    <Dialog open={!!taskId} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-2xl">
        {task ? <LaunchContent key={task.id} task={task} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function LaunchContent({ task, onDone }: { task: TaskSummary; onDone: () => void }) {
  const options = useT3LaunchOptions(task.id);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Start in T3 Code</DialogTitle>
        <DialogDescription>
          #{task.number} {task.title}
        </DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {options.isPending ? (
          <Skeleton shape="card" className="h-40 w-full" />
        ) : options.isError ? (
          <LaunchUnavailable task={task} message={options.error.message} onRetry={() => void options.refetch()} />
        ) : (
          <Composer task={task} options={options.data} onDone={onDone} />
        )}
      </div>
    </>
  );
}

function LaunchUnavailable({ task, message, onRetry }: { task: TaskSummary; message: string; onRetry: () => void }) {
  const modelTiers = useSettings().data?.modelTiers;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 text-sm">
      <p className="flex items-start gap-2">
        <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>{message}</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copyHandoffPrompt(task, defaultHandoffMode(task), modelTiers)}>
          Copy prompt instead
        </Button>
      </div>
    </div>
  );
}

function Composer({ task, options, onDone }: { task: TaskSummary; options: T3LaunchOptions; onDone: () => void }) {
  // An epic's thread orchestrates its tasks, which carry the plans, so it has no "Plan with me".
  const epic = task.kind === "epic";
  const promptFor = (plan: boolean) =>
    taskHandoffPrompt({
      task,
      boardUrl: window.location.origin,
      mode: epic ? "orchestrate" : plan ? "plan" : "work",
      linkedThread: true,
    });
  const [planWithMe, setPlanWithMe] = useState(() => defaultHandoffMode(task) === "plan");
  const [prompt, setPrompt] = useState(() => promptFor(planWithMe));
  const [selection, setSelection] = useState<T3ModelSelection | null>(() => launchModelSelection(options, planWithMe));
  const provider = options.providers.find((p) => p.instanceId === selection?.instanceId);
  const [runtimeMode, setRuntimeMode] = useState(() => clampRuntimeMode(options.defaults.runtimeMode, provider));
  const [choice, setChoice] = useState<WorkspaceChoice>(() => initialWorkspaceChoice(options));
  const start = useStartT3Thread({ silent: true });
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());

  const workspace = toLaunchWorkspace(options, choice);
  const model = findModel(options, selection);
  const blocker =
    !selection || !model?.provider.ready ? "Choose an available model" : !workspace ? "Choose a branch" : null;

  const changeSelection = (next: T3ModelSelection | null) => {
    setSelection(next);
    const nextProvider = options.providers.find((p) => p.instanceId === next?.instanceId);
    setRuntimeMode((mode) => clampRuntimeMode(mode, nextProvider));
  };

  const togglePlan = () => {
    const next = !planWithMe;
    // Swap the generated prompt and the mode's model, but never discard the user's own choices.
    if (prompt === promptFor(planWithMe)) setPrompt(promptFor(next));
    changeSelection(selectionAfterPlanToggle(options, selection, next));
    setPlanWithMe(next);
  };

  const submit = () => {
    if (blocker || !selection || !workspace || !prompt.trim()) return;
    start.mutate(
      {
        taskId: task.id,
        commandId,
        prompt,
        modelSelection: selection,
        runtimeMode,
        workspace,
      },
      {
        onSuccess: () => {
          toastManager.add({
            type: "success",
            title: "Started in T3 Code",
            description: `#${task.number} is linked to the new thread.`,
          });
          onDone();
        },
        onError: (error) => {
          if (error instanceof ApiError && !keepsCommandId(error.details)) setCommandId(crypto.randomUUID());
          toastManager.add({ type: "error", title: "Couldn't start the thread", description: error.message });
        },
      },
    );
  };

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="relative z-10 rounded-2xl border border-border bg-card shadow-sm/5">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          aria-label="First message"
          className="field-sizing-content block max-h-72 min-h-28 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <ModelPicker options={options} selection={selection} onChange={changeSelection} />
          {selection ? <TraitsPicker options={options} selection={selection} onChange={setSelection} /> : null}
          <AccessPicker provider={provider} value={runtimeMode} onChange={setRuntimeMode} />
          {epic ? null : (
            <ComposerControl
              aria-pressed={planWithMe}
              onClick={togglePlan}
              title="The agent shapes the plan with you before any code is written"
            >
              <LightbulbIcon />
              <span>Plan with me</span>
            </ComposerControl>
          )}
          <button
            type="submit"
            aria-label="Start thread"
            title={blocker ?? "Start thread (Ctrl+Enter)"}
            disabled={!!blocker || start.isPending || !prompt.trim()}
            className={cn(
              "ms-auto flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
            )}
          >
            {start.isPending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </button>
        </div>
      </div>
      <div className="-mt-3 flex items-center justify-between rounded-b-xl border border-t-0 border-border bg-muted/30 px-2 pt-4 pb-1.5">
        <WorkspaceMenu options={options} choice={choice} onChange={setChoice} />
        <RefPicker options={options} choice={choice} onChange={setChoice} />
      </div>
      {options.suggestion ? <SuggestionNote suggestion={options.suggestion} planWithMe={planWithMe} /> : null}
    </form>
  );
}

/** Which model tier the task's planner suggested, and whether the dialog is using it. */
function SuggestionNote({ suggestion, planWithMe }: { suggestion: T3LaunchSuggestion; planWithMe: boolean }) {
  const status = planWithMe
    ? "Not used while planning."
    : suggestion.unavailable
      ? `${suggestion.unavailable} Using T3's default instead.`
      : null;
  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Suggested model: {suggestion.tier}</span>
      {suggestion.reason ? ` · ${suggestion.reason}` : null}
      {status ? (
        <span className={cn("block", !planWithMe && suggestion.unavailable && "text-warning")}>{status}</span>
      ) : null}
    </p>
  );
}
