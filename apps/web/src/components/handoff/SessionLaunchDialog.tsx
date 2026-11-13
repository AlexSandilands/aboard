import {
  AGENT_HARNESSES,
  customHandoffLabel,
  customHandoffModel,
  renderCustomHandoffPrompt,
  taskHandoffPrompt,
  taskWindowName,
  defaultHandoffMode,
  type AgentHarness,
  type AppSettings,
  type CliEffort,
  type CustomHandoff,
  type PrFixInfo,
  type SessionLaunchOptions,
  type TaskSummary,
} from "@repo/contracts";
import { ArrowUpIcon, LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { CliModelPicker } from "~/components/models/ModelChoicePicker";
import { modelLevels } from "~/components/models/choicePicker.logic";
import { copyToClipboard } from "~/components/task/InlineInput";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useStartSession } from "~/state/mutations";
import {
  useAgentModels,
  useBoard,
  useFollowupEpicBranch,
  usePrFix,
  useSessionLaunchOptions,
  useSettingsSelect,
} from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { effortAfterModelChange } from "./cliEffort.logic";
import { copyFixPrompt } from "./FixPrMenu";
import { AddImageControl, LaunchImageThumbs, useLaunchImages } from "./LaunchImages";
import { LaunchUnavailable, ToolbarSkeleton } from "./LaunchStates";
import { BranchPicker } from "./BranchPicker";
import { announceSession } from "./announceSession";
import { HandoffBadge, HandoffNote } from "./HandoffPreset";
import { ComposerControl, ComposerStrip } from "./T3LaunchPickers";
import {
  branchRows,
  emptySessionPickState,
  harnessLabel,
  modelError,
  pickPinnedBranch,
  pickSessionBy,
  picksAfterPlanToggle,
  pinnedBranchRows,
  syncSessionPicks,
  taskWorktreeWhere,
  toSessionWorkspace,
  whereBranch,
  whereBranchLabel,
  type SessionPicks,
  type SessionWhere,
} from "./sessionLaunch.logic";

/** What says which model a hand-off's choice comes down to. */
const selectModelSettings = ({ modelTiers, modelProfiles, operationModels }: AppSettings) => ({
  modelTiers,
  modelProfiles,
  operationModels,
});

const WHERE_LABELS = {
  new_worktree: "New worktree",
  existing_worktree: "Task worktree",
  current: "This checkout",
} as const;

/**
 * "New Claude Code / Codex / Copilot CLI session": the hand-off prompt to edit, a model and where to run, then the CLI
 * opens in a terminal with the prompt and the board links the session, or, for Codex, the session links itself
 * (useDialogs().openSessionLaunch). With a `fixLinkId`
 * ("Fix in →" on a PR) the prompt is Fix PRs' for the PR's problems and the session works on the PR's own branch. With
 * a `preset` it opens on a custom hand-off's prompt, model and workspace.
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
            key={`${task.id}:${target.harness}:${target.fixLinkId ?? ""}:${target.preset?.id ?? ""}`}
            task={task}
            harness={target.harness}
            fixLinkId={target.fixLinkId ?? null}
            preset={target.fixLinkId ? null : (target.preset ?? null)}
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
  preset,
  onDone,
}: {
  task: TaskSummary;
  harness: AgentHarness;
  fixLinkId: string | null;
  preset: CustomHandoff | null;
  onDone: () => void;
}) {
  // A hand-off's options start on its model rather than the task's.
  const options = useSessionLaunchOptions(task.id, preset?.id);
  const fix = usePrFix(fixLinkId, harness);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <HarnessIcon harness={harness} className="size-4" />
          {fixLinkId ? `Fix the PR in ${harnessLabel(harness)}` : `New ${harnessLabel(harness)} session`}
          {preset ? <HandoffBadge name={preset.name} /> : null}
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
            preset={preset}
            onDone={onDone}
          />
        )}
      </div>
    </>
  );
}

function Composer({
  task,
  harness,
  options,
  failure,
  fix,
  preset,
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
  /** The custom hand-off the dialog opens on: its prompt, and its model and workspace picked. */
  preset: CustomHandoff | null;
  onDone: () => void;
}) {
  // An epic's session orchestrates its tasks, which carry the plans, so it has no "Plan with me"; nor has a follow-up
  // on a Done task, whose work is finished.
  const epic = task.kind === "epic";
  const followup = !fix && defaultHandoffMode(task) === "followup";
  const epicBranch = useFollowupEpicBranch(task);
  const mode = fix ? "fix" : epic ? "orchestrate" : followup ? "followup" : null;
  const promptFor = (plan: boolean) =>
    fix
      ? fix.prompt
      : preset
        ? renderCustomHandoffPrompt(preset, task, window.location.origin)
        : taskHandoffPrompt({
            task,
            boardUrl: window.location.origin,
            mode: epic ? "orchestrate" : followup ? "followup" : plan ? "plan" : "work",
            linkedSession: true,
            // Codex picks its own session id, so its prompt asks it to link itself.
            sessionHarness: harness,
            epicBranch,
          });
  // A hand-off's own text has no planning variant, so its dialog has no Plan with me.
  const [plan, setPlan] = useState(!fix && !preset && defaultHandoffMode(task) === "plan");
  const [prompt, setPrompt] = useState(() => promptFor(plan));
  // The choices start from the options. The dialog may open on cached ones that a refresh then changes (the task's
  // model, say), so until the user picks something they follow the newest; after that a refresh never moves them.
  // A follow-up starts where the code is: the epic's branch while it's only there, else the default branch.
  const integrationBranch = followup ? epicBranch : task.integrationBranch;
  const [pickState, setPickState] = useState(() =>
    syncSessionPicks(emptySessionPickState, options, harness, plan, integrationBranch, preset?.workspace ?? null),
  );
  const synced = syncSessionPicks(pickState, options, harness, plan, integrationBranch, preset?.workspace ?? null);
  if (synced !== pickState) setPickState(synced);
  const ready = options && synced.picks ? { options, ...synced.picks } : null;
  // The models the CLI lists, for the picker; anything else can still be typed while the scan runs or if it fails.
  const scanned = useAgentModels(true);
  const start = useStartSession({ silent: true });
  // Whether the model shown is the hand-off's own: not when it inherits, nor when its custom model was since deleted
  // and the task's own model stands in.
  const modelSettings = useSettingsSelect(selectModelSettings);
  const handoffChoice =
    preset && modelSettings && customHandoffModel(preset, task, modelSettings).resolved.source === "automation"
      ? preset.model
      : null;
  const handoffPickedModel =
    !handoffChoice || handoffChoice === "inherit" ? null : "tier" in handoffChoice ? "tier" : "model";
  const images = useLaunchImages();
  const cli = options?.clis.find((c) => c.harness === harness);
  // Codex can't be given a session id: the board can't link it, and its prompt asks it to link itself.
  const selfLinks = !AGENT_HARNESSES[harness].presetSessionId;

  // A fix works on the PR's own branch, in a worktree of its own: there is no checkout to run it in.
  const workspace = !ready
    ? null
    : fix
      ? ready.options.isRepo
        ? { mode: "pr_branch" as const, branch: fix.branch }
        : null
      : toSessionWorkspace(ready.where);
  const model = ready?.model ?? "";
  const levels = modelLevels(scanned.data, harness, model.trim() || null);
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
  const pickModel = (next: string | null, nextLevels: readonly CliEffort[]) =>
    pick((picks) => ({
      ...picks,
      model: next ?? "",
      // The effort goes with the model: kept while the new one takes it.
      effort: effortAfterModelChange(picks.effort, nextLevels),
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
        mode: mode ?? (plan ? "plan" : "work"),
        prompt,
        // Linked under the hand-off's name, which its prompt also gives a session that links itself.
        ...(preset ? { label: customHandoffLabel(preset, task) } : {}),
        ...(images.ids.length > 0 ? { attachmentIds: images.ids } : {}),
        model: ready.model.trim() || null,
        // A model that takes no effort gets none, whatever was picked for the one before it.
        effort: levels.length > 0 ? ready.effort : null,
        workspace,
      },
      {
        onSuccess: (result) => {
          announceSession(result, {
            harness,
            prompt,
            taskNumbers: [task.number],
            existingWorktree: workspace.mode === "existing_worktree",
          });
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
          className="field-sizing-content mx-2 mt-2 block max-h-72 min-h-26 w-[calc(100%-1rem)] resize-none bg-transparent px-3 pt-2 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <LaunchImageThumbs state={images} />
        <div className="flex min-w-0 items-center gap-1 px-3 pb-3">
          {ready ? (
            <>
              <CliModelPicker
                harness={harness}
                ariaLabel="Model"
                defaultLabel="Default model"
                model={ready.model}
                effort={ready.effort}
                // The one toolbar control that may shrink, so the submit arrow stays inside the composer.
                className="max-w-80 shrink"
                onModel={pickModel}
                onEffort={(effort) => pick((picks) => ({ ...picks, effort }))}
              />
            </>
          ) : failure ? null : (
            <ToolbarSkeleton />
          )}
          {fix || epic || followup || preset ? null : (
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
                {handoffPickedModel
                  ? // The options were loaded for the hand-off, so this is the model it picked.
                    `Model: ${options.model.name}${handoffPickedModel === "tier" ? " tier" : ""}, from the hand-off`
                  : options.model.source === "label"
                    ? `Model: ${options.model.name}, from label ${options.model.label}`
                    : `Suggested model: ${options.model.name}`}
              </span>
              {options.models[harness]
                ? null
                : ` · no ${harnessLabel(harness)} model is set for ${options.model.source === "label" ? "it" : "this tier"} in Settings → Agents → Models`}
            </span>
          ) : null}
          {options.namedWindow
            ? `Opens in the Windows Terminal window ${taskWindowName(task.number)}${selfLinks ? "." : ", which the session's link brings back while it runs."}`
            : "Opens in the terminal chosen in Settings → Integrations → Terminal."}
          {selfLinks
            ? ` ${harnessLabel(harness)} picks its own session id, so the session links itself to the task once it starts.`
            : null}
        </p>
      ) : null}
      {preset ? <HandoffNote name={preset.name} /> : null}
    </form>
  );
}

/**
 * Where a task's session runs: a new worktree from a branch, one of the task's own worktrees, or the project's
 * checkout. The branch picker pins the task's branches: one with a worktree runs the session there.
 */
function WhereStrip({
  options,
  where,
  onChange,
}: {
  options: SessionLaunchOptions;
  where: SessionWhere;
  onChange: (where: SessionWhere) => void;
}) {
  const taskWorktree = taskWorktreeWhere(options);
  const items = [
    { value: "new_worktree" as const, label: WHERE_LABELS.new_worktree },
    ...(taskWorktree ? [{ value: "existing_worktree" as const, label: WHERE_LABELS.existing_worktree }] : []),
    { value: "current" as const, label: WHERE_LABELS.current },
  ];
  return (
    <>
      <Select
        items={items}
        value={where.mode}
        disabled={!options.isRepo}
        onValueChange={(value) =>
          onChange(
            value === "current"
              ? { mode: "current" }
              : value === "existing_worktree" && taskWorktree
                ? taskWorktree
                : { mode: "new_worktree", baseRef: options.defaultBaseRef },
          )
        }
      >
        <SelectTrigger size="sm" variant="ghost" aria-label="Where to run" className="w-auto">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {where.mode === "current" ? (
        <span className="truncate px-2 text-xs text-muted-foreground" title={options.workspaceRoot ?? undefined}>
          {options.workspaceRoot ?? "No project folder"}
        </span>
      ) : (
        <span
          className="flex min-w-0 items-center gap-1"
          title={where.mode === "existing_worktree" ? where.worktreePath : undefined}
        >
          <BranchPicker
            label={whereBranchLabel(where)}
            disabled={false}
            pinned={pinnedBranchRows(options)}
            rows={branchRows(options)}
            selected={whereBranch(where)}
            onPick={(baseRef) => onChange({ mode: "new_worktree", baseRef })}
            onPickPinned={(name) => {
              const next = pickPinnedBranch(options, name);
              if (next) onChange(next);
            }}
            footer={
              pinnedBranchRows(options).length > 0
                ? "A task branch with its own worktree runs the session there. Pick it under All refs to branch from it."
                : null
            }
          />
        </span>
      )}
    </>
  );
}
