import {
  modelEffortLevels,
  taskHandoffPrompt,
  taskWindowName,
  defaultHandoffMode,
  type AgentHarness,
  type PrFixInfo,
  type SessionLaunchOptions,
  type StartSessionResult,
  type TaskSummary,
} from "@repo/contracts";
import { ArrowUpIcon, LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { CliEffortMenu, CliModelPicker } from "~/components/settings/CliModelPicker";
import { findSuggestion } from "~/components/settings/cliModelPicker.logic";
import { copyToClipboard } from "~/components/task/InlineInput";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useStartSession } from "~/state/mutations";
import { useAgentModels, useBoard, usePrFix, useSessionLaunchOptions } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { effortAfterModelChange } from "./cliEffort.logic";
import { copyFixPrompt } from "./FixPrMenu";
import { AddImageControl, LaunchImageThumbs, useLaunchImages } from "./LaunchImages";
import { LaunchUnavailable, ToolbarSkeleton } from "./LaunchStates";
import { ComposerControl, ComposerStrip } from "./T3LaunchPickers";
import {
  emptySessionPickState,
  harnessLabel,
  modelError,
  pickSessionBy,
  picksAfterPlanToggle,
  startedDescription,
  syncSessionPicks,
  toSessionWorkspace,
  type SessionPicks,
} from "./sessionLaunch.logic";

const WHERE_ITEMS = [
  { value: "new_worktree", label: "New worktree" },
  { value: "current", label: "This checkout" },
] as const;

/**
 * "New Claude Code / Copilot CLI session": the hand-off prompt to edit, a model and where to run, then the CLI opens
 * in a terminal with the prompt and the board links the session (useDialogs().openSessionLaunch). With a `fixLinkId`
 * ("Fix in →" on a PR) the prompt is Fix PRs' for the PR's problems and the session works on the PR's own branch.
 */
export function SessionLaunchDialog() {
  const target = useDialogs((s) => s.sessionLaunch);
  const close = useDialogs((s) => s.closeSessionLaunch);
  const task = useBoard().data?.tasks.find((t) => t.id === target?.taskId);
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-220">
        {task && target ? (
          <SessionLaunch
            key={`${task.id}:${target.harness}:${target.fixLinkId ?? ""}`}
            task={task}
            harness={target.harness}
            fixLinkId={target.fixLinkId ?? null}
            onDone={close}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function SessionLaunch({
  task,
  harness,
  fixLinkId,
  onDone,
}: {
  task: TaskSummary;
  harness: AgentHarness;
  fixLinkId: string | null;
  onDone: () => void;
}) {
  const options = useSessionLaunchOptions(task.id);
  const fix = usePrFix(fixLinkId);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <HarnessIcon harness={harness} className="size-4" />
          {fixLinkId ? `Fix the PR in ${harnessLabel(harness)}` : `New ${harnessLabel(harness)} session`}
        </DialogTitle>
        <DialogDescription>
          #{task.number} {task.title}
        </DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {/* A fix's prompt is the PR's problems, so its composer waits for them; a task's prompt is there at once. */}
        {fixLinkId && fix.isPending ? (
          <Skeleton shape="card" className="h-40 w-full" />
        ) : fixLinkId && !fix.data ? (
          <LaunchUnavailable
            message={fix.error?.message ?? "Couldn't read the PR's problems"}
            onRetry={() => void fix.refetch()}
            // Read again, with its error shown; never the task's work prompt.
            onCopy={() => void copyFixPrompt(fixLinkId)}
          />
        ) : (
          // One element while the options load, fail and arrive, so what is typed meanwhile is kept.
          <Composer
            task={task}
            harness={harness}
            options={options.data}
            // Not once there are options: a failed background refresh must not make the dialog look broken.
            failure={
              !options.data && options.isError && !options.isFetching
                ? { message: options.error.message, onRetry: () => void options.refetch() }
                : null
            }
            fix={fixLinkId ? (fix.data ?? null) : null}
            onDone={onDone}
          />
        )}
      </div>
    </>
  );
}

/**
 * Toasts what starting a session did. A terminal that didn't open offers the command to run by hand; a CLI that got
 * the short prompt gets the full one on the clipboard (or a button to copy it, when the clipboard refuses).
 */
export function announceSession(
  result: StartSessionResult,
  { harness, prompt, taskNumbers }: { harness: AgentHarness; prompt: string; taskNumbers: readonly number[] },
) {
  if (!result.launched) {
    const toastId = toastManager.add({
      type: "error",
      title: "Couldn't open a terminal",
      description: `${result.error ?? "The terminal didn't start."} Run the command yourself instead${result.branch ? `: it runs in the new worktree on ${result.branch}` : ""}.`,
      actionProps: {
        children: "Copy command",
        onClick: () => {
          toastManager.close(toastId);
          copyToClipboard(result.command, "command");
        },
      },
    });
    return;
  }
  const announce = (copied: boolean) => {
    const toastId = toastManager.add({
      type: "success",
      title: `Started ${harnessLabel(harness)}`,
      description: [result.shortReason, startedDescription(result, taskNumbers, copied)].filter(Boolean).join(" "),
      // The clipboard can refuse a write that comes after the request; a click is a fresh gesture.
      ...(result.shortPrompt && !copied
        ? {
            actionProps: {
              children: "Copy prompt",
              onClick: () => {
                toastManager.close(toastId);
                copyToClipboard(prompt, "prompt");
              },
            },
          }
        : {}),
    });
  };
  // The CLI got a short pointer to the task; the full prompt goes on the clipboard to paste into it.
  if (result.shortPrompt) {
    navigator.clipboard.writeText(prompt).then(
      () => announce(true),
      () => announce(false),
    );
  } else announce(false);
}

function Composer({
  task,
  harness,
  options,
  failure,
  fix,
  onDone,
}: {
  task: TaskSummary;
  harness: AgentHarness;
  /** Undefined while they load: the prompt can be edited meanwhile, the rest waits for them. */
  options: SessionLaunchOptions | undefined;
  /** Set when loading them failed: shown under the composer, which stays so the prompt isn't lost. */
  failure: { message: string; onRetry: () => void } | null;
  /** Set to fix a PR: its prompt and branch, which the session works on. */
  fix: PrFixInfo | null;
  onDone: () => void;
}) {
  // An epic's session orchestrates its tasks, which carry the plans, so it has no "Plan with me".
  const epic = task.kind === "epic";
  const promptFor = (plan: boolean) =>
    fix
      ? fix.prompt
      : taskHandoffPrompt({
          task,
          boardUrl: window.location.origin,
          mode: epic ? "orchestrate" : plan ? "plan" : "work",
          linkedSession: true,
        });
  const [plan, setPlan] = useState(!fix && defaultHandoffMode(task) === "plan");
  const [prompt, setPrompt] = useState(() => promptFor(plan));
  // The choices start from the options. The dialog may open on cached ones that a refresh then changes (the task's
  // model, say), so until the user picks something they follow the newest; after that a refresh never moves them.
  const integrationBranch = task.integrationBranch;
  const [pickState, setPickState] = useState(() =>
    syncSessionPicks(emptySessionPickState, options, harness, plan, integrationBranch),
  );
  const synced = syncSessionPicks(pickState, options, harness, plan, integrationBranch);
  if (synced !== pickState) setPickState(synced);
  const ready = options && synced.picks ? { options, ...synced.picks } : null;
  // The models the CLI lists, for the picker; anything else can still be typed while the scan runs or if it fails.
  const scanned = useAgentModels(true);
  const models = scanned.data?.harnesses.find((h) => h.harness === harness)?.models ?? [];
  const start = useStartSession({ silent: true });
  const images = useLaunchImages();
  const cli = options?.clis.find((c) => c.harness === harness);

  // A fix works on the PR's own branch, in a worktree of its own: there is no checkout to run it in.
  const workspace = !ready
    ? null
    : fix
      ? ready.options.isRepo
        ? { mode: "pr_branch" as const, branch: fix.branch }
        : null
      : toSessionWorkspace(ready.where);
  const model = ready?.model ?? "";
  const levels = modelEffortLevels(harness, findSuggestion(models, model));
  const badModel = modelError(model);
  const blocker = !ready
    ? failure
      ? "The launch options didn't load"
      : "Loading the launch options"
    : !cli?.available
      ? `${harnessLabel(harness)} isn't installed`
      : !ready.options.workspaceRoot
        ? "The project has no folder"
        : !workspace
          ? fix
            ? "The project's folder isn't a git repository"
            : "Choose a branch"
          : (badModel ?? images.blocker);

  const pick = (change: (picks: SessionPicks) => SessionPicks) => setPickState((state) => pickSessionBy(state, change));
  const pickModel = (next: string) =>
    pick((picks) => ({
      ...picks,
      model: next,
      // The effort goes with the model: kept while the new one takes it.
      effort: effortAfterModelChange(picks.effort, modelEffortLevels(harness, findSuggestion(models, next))),
    }));

  const togglePlan = () => {
    const next = !plan;
    // Swap what the dialog generated, but never discard what the user typed or picked.
    if (prompt === promptFor(plan)) setPrompt(promptFor(next));
    // Still loading: the choices are made from the options when they arrive, for the mode the dialog is then in.
    if (ready) {
      setPickState((state) =>
        state.picks ? { ...state, picks: picksAfterPlanToggle(state.picks, ready.options, harness, plan) } : state,
      );
    }
    setPlan(next);
  };

  const submit = () => {
    if (blocker || !ready || !workspace || !prompt.trim() || start.isPending) return;
    start.mutate(
      {
        taskId: task.id,
        harness,
        mode: fix ? "fix" : epic ? "orchestrate" : plan ? "plan" : "work",
        prompt,
        ...(images.ids.length > 0 ? { attachmentIds: images.ids } : {}),
        model: ready.model.trim() || null,
        // A model that takes no effort gets none, whatever was picked for the one before it.
        effort: levels.length > 0 ? ready.effort : null,
        workspace,
      },
      {
        onSuccess: (result) => {
          announceSession(result, { harness, prompt, taskNumbers: [task.number] });
          // Closed even when the terminal didn't open, so starting again doesn't quietly make a second worktree
          // beside the one the command uses.
          onDone();
        },
        onError: (error) =>
          toastManager.add({ type: "error", title: "Couldn't start the session", description: error.message }),
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
          {...images.handlers}
          aria-label="First message"
          className="field-sizing-content block max-h-72 min-h-28 w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <LaunchImageThumbs state={images} />
        <div className="flex min-w-0 items-center gap-1 px-3 pb-3">
          {ready ? (
            <>
              <CliModelPicker
                harness={harness}
                cliName={harnessLabel(harness)}
                label="Model"
                defaultLabel="Default model"
                value={ready.model}
                models={models}
                loading={scanned.isFetching}
                // The one toolbar control that may shrink, so the submit arrow stays inside the composer.
                className="max-w-80 shrink"
                onSave={pickModel}
              />
              {levels.length > 0 ? (
                <CliEffortMenu
                  label="Effort"
                  value={ready.effort}
                  levels={levels}
                  onChange={(effort) => pick((picks) => ({ ...picks, effort }))}
                />
              ) : null}
            </>
          ) : failure ? null : (
            <ToolbarSkeleton />
          )}
          {fix || epic ? null : (
            <ComposerControl
              aria-pressed={plan}
              onClick={togglePlan}
              title="The agent shapes the plan with you before any code is written"
            >
              <LightbulbIcon />
              <span>Plan with me</span>
            </ComposerControl>
          )}
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            <AddImageControl state={images} />
            <button
              type="submit"
              aria-label="Start session"
              title={blocker ?? "Start session (Ctrl+Enter)"}
              disabled={!!blocker || start.isPending || !prompt.trim()}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
              )}
            >
              {start.isPending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
            </button>
          </div>
        </div>
      </div>
      <ComposerStrip className="justify-between gap-2">
        {!ready ? (
          failure ? null : (
            <>
              <Skeleton className="my-1 h-4 w-28" />
              <Skeleton className="my-1 h-4 w-36" />
            </>
          )
        ) : fix ? (
          <span
            className="truncate px-2 py-1 text-xs text-muted-foreground"
            title={ready.options.workspaceRoot ?? undefined}
          >
            New worktree on the PR's branch <span className="font-mono text-foreground/80">{fix.branch}</span>
          </span>
        ) : (
          <WhereStrip
            options={ready.options}
            where={ready.where}
            onChange={(where) => pick((picks) => ({ ...picks, where }))}
          />
        )}
      </ComposerStrip>
      {failure && !options ? (
        <LaunchUnavailable
          message={failure.message}
          onRetry={failure.onRetry}
          onCopy={() => copyToClipboard(prompt, fix ? "fix prompt" : "prompt")}
        />
      ) : null}
      {options ? (
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {options.model && !plan ? (
            <span className="block">
              <span className="font-medium text-foreground">
                {options.model.source === "label"
                  ? `Model: ${options.model.name}, from label ${options.model.label}`
                  : `Suggested model: ${options.model.name}`}
              </span>
              {options.models[harness]
                ? null
                : ` · no ${harnessLabel(harness)} model is set for ${options.model.source === "label" ? "it" : "this tier"} in Settings → Model tiers`}
            </span>
          ) : null}
          {options.namedWindow
            ? `Opens in the Windows Terminal window ${taskWindowName(task.number)}, which the session's link brings back while it runs.`
            : "Opens in the terminal chosen in Settings → Integrations → Terminal."}
        </p>
      ) : null}
    </form>
  );
}

/** Where a task's session runs: a new worktree from a branch, or the project's checkout. */
function WhereStrip({
  options,
  where,
  onChange,
}: {
  options: SessionLaunchOptions;
  where: SessionPicks["where"];
  onChange: (where: SessionPicks["where"]) => void;
}) {
  return (
    <>
      <Select
        items={WHERE_ITEMS}
        value={where.mode}
        disabled={!options.isRepo}
        onValueChange={(value) =>
          onChange(
            value === "current" ? { mode: "current" } : { mode: "new_worktree", baseRef: options.defaultBaseRef },
          )
        }
      >
        <SelectTrigger size="sm" variant="ghost" aria-label="Where to run" className="w-auto">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {WHERE_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {where.mode === "new_worktree" ? (
        <Select
          items={options.branches.map((b) => ({ value: b, label: b }))}
          value={where.baseRef}
          onValueChange={(value) => onChange({ mode: "new_worktree", baseRef: value })}
        >
          <SelectTrigger size="sm" variant="ghost" aria-label="Branch to start from" className="w-auto max-w-64">
            <SelectValue placeholder="Choose a branch" />
          </SelectTrigger>
          <SelectPopup>
            {options.branches.map((branch) => (
              <SelectItem key={branch} value={branch}>
                {branch}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <span className="truncate px-2 text-xs text-muted-foreground" title={options.workspaceRoot ?? undefined}>
          {options.workspaceRoot ?? "No project folder"}
        </span>
      )}
    </>
  );
}
