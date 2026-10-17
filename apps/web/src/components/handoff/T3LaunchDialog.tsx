import {
  clampRuntimeMode,
  defaultHandoffMode,
  suggestEpicsPrompt,
  taskHandoffPrompt,
  type PrFixInfo,
  type Project,
  type StartT3ThreadInput,
  type T3LaunchOptions,
  type T3LaunchSuggestion,
  type T3ModelSelection,
  type T3ThreadRef,
  type TaskSummary,
} from "@repo/contracts";
import { AlertCircleIcon, ArrowUpIcon, LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { copyToClipboard } from "~/components/task/InlineInput";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { ApiError } from "~/lib/api";
import { openHref, t3LinkTargets } from "~/lib/t3Links";
import { cn } from "~/lib/utils";
import { useStartProjectT3Thread, useStartT3Thread } from "~/state/mutations";
import { useBoard, usePrFix, useProjectT3LaunchOptions, useSettings, useT3LaunchOptions } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import {
  keepsCommandId,
  findModel,
  initialWorkspaceChoice,
  launchModelSelection,
  selectionAfterPlanToggle,
  toLaunchWorkspace,
  type WorkspaceChoice,
} from "./handoff.logic";
import { copyHandoffPrompt, copySuggestEpicsPrompt } from "./HandoffActions";
import { AccessPicker, ComposerControl, ModelPicker, RefPicker, TraitsPicker, WorkspaceMenu } from "./T3LaunchPickers";

/** What the dialog starts a thread for: a task, which the thread is linked to, or a project's Suggest epics. */
interface LaunchSubject {
  /** Shown under the dialog's title. */
  label: string;
  /** The generated first message; `plan` is the "Plan with me" toggle where the subject has one. */
  promptFor: (plan: boolean) => string;
  planToggle: boolean;
  initialPlan: boolean;
  successDescription: string;
  copyPrompt: () => void;
  /** Offer to open the new thread: nothing on the board links to a project's thread. */
  offerOpen: boolean;
  /** An integration epic's branch, which the task's worktree starts from by default. */
  integrationBranch?: string | null;
  /** A PR's branch the thread works on ("Fix in →"): the worktree starts from it, and the dialog says when it doesn't. */
  fixBranch?: string | null;
}

/** The subject's launch mutation, with its id already bound. */
interface Starter {
  isPending: boolean;
  start: (
    input: StartT3ThreadInput,
    callbacks: { onSuccess: (thread: T3ThreadRef | null) => void; onError: (error: Error) => void },
  ) => void;
}

type LaunchOptionsQuery = ReturnType<typeof useT3LaunchOptions>;

/**
 * "Start in T3 Code": a new-thread composer for a task (useDialogs().openT3Launch; with a `fixLinkId`, "Fix in →" on a
 * PR: Fix PRs' prompt for its problems, in a worktree from its branch) or for a project's Suggest epics
 * (openProjectT3Launch).
 */
export function T3LaunchDialog() {
  const target = useDialogs((s) => s.t3Launch);
  const close = useDialogs((s) => s.closeT3Launch);
  const board = useBoard().data;
  const task = target?.kind === "task" ? board?.tasks.find((t) => t.id === target.taskId) : undefined;
  const project = target?.kind === "project" ? board?.projects.find((p) => p.id === target.projectId) : undefined;
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-2xl">
        {task && target?.kind === "task" ? (
          <TaskLaunch
            key={`${task.id}:${target.fixLinkId ?? ""}`}
            task={task}
            fixLinkId={target.fixLinkId ?? null}
            onDone={close}
          />
        ) : null}
        {project ? <ProjectLaunch key={project.id} project={project} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function TaskLaunch({ task, fixLinkId, onDone }: { task: TaskSummary; fixLinkId: string | null; onDone: () => void }) {
  const fix = usePrFix(fixLinkId);
  if (!fixLinkId) return <TaskLaunchContent task={task} fix={null} onDone={onDone} />;
  if (fix.data) return <TaskLaunchContent task={task} fix={fix.data} onDone={onDone} />;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Fix the PR in T3 Code</DialogTitle>
        <DialogDescription>
          #{task.number} {task.title}
        </DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {fix.isError ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 text-sm">
            <p className="flex items-start gap-2">
              <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{fix.error.message}</span>
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void fix.refetch()}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <Skeleton shape="card" className="h-40 w-full" />
        )}
      </div>
    </>
  );
}

function TaskLaunchContent({ task, fix, onDone }: { task: TaskSummary; fix: PrFixInfo | null; onDone: () => void }) {
  const options = useT3LaunchOptions(task.id);
  const modelTiers = useSettings().data?.modelTiers;
  const mutation = useStartT3Thread({ silent: true });
  // An epic's thread orchestrates its tasks, which carry the plans, so it has no "Plan with me".
  const epic = task.kind === "epic";
  const subject: LaunchSubject = fix
    ? {
        label: `Fix PR #${fix.number} · #${task.number} ${task.title}`,
        promptFor: () => fix.prompt,
        planToggle: false,
        initialPlan: false,
        successDescription: `#${task.number} is linked to the new thread, which works on ${fix.branch}.`,
        copyPrompt: () => copyToClipboard(fix.prompt, "fix prompt"),
        offerOpen: false,
        integrationBranch: fix.branch,
        fixBranch: fix.branch,
      }
    : {
        label: `#${task.number} ${task.title}`,
        promptFor: (plan) =>
          taskHandoffPrompt({
            task,
            boardUrl: window.location.origin,
            mode: epic ? "orchestrate" : plan ? "plan" : "work",
            linkedThread: true,
          }),
        planToggle: !epic,
        // An epic has no suggested model, so it starts on T3's default model, which is also what planning uses.
        initialPlan: defaultHandoffMode(task) === "plan",
        successDescription: `#${task.number} is linked to the new thread.`,
        copyPrompt: () => copyHandoffPrompt(task, defaultHandoffMode(task), modelTiers),
        offerOpen: false,
        integrationBranch: epic ? null : task.integrationBranch,
      };
  const starter: Starter = {
    isPending: mutation.isPending,
    start: (input, { onSuccess, onError }) =>
      mutation.mutate(
        { taskId: task.id, ...input },
        { onSuccess: (link) => onSuccess(link.kind === "t3_thread" ? link.ref : null), onError },
      ),
  };
  return <LaunchContent subject={subject} options={options} starter={starter} onDone={onDone} />;
}

function ProjectLaunch({ project, onDone }: { project: Project; onDone: () => void }) {
  const options = useProjectT3LaunchOptions(project.id);
  const mutation = useStartProjectT3Thread({ silent: true });
  const subject: LaunchSubject = {
    label: `Suggest epics for ${project.title}`,
    promptFor: () => suggestEpicsPrompt({ project, boardUrl: window.location.origin }),
    planToggle: false,
    initialPlan: false,
    successDescription: `The new thread will propose epics for ${project.title}.`,
    copyPrompt: () => copySuggestEpicsPrompt(project),
    offerOpen: true,
  };
  const starter: Starter = {
    isPending: mutation.isPending,
    start: (input, callbacks) => mutation.mutate({ projectId: project.id, ...input }, callbacks),
  };
  return <LaunchContent subject={subject} options={options} starter={starter} onDone={onDone} />;
}

function LaunchContent({
  subject,
  options,
  starter,
  onDone,
}: {
  subject: LaunchSubject;
  options: LaunchOptionsQuery;
  starter: Starter;
  onDone: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{subject.fixBranch ? "Fix the PR in T3 Code" : "Start in T3 Code"}</DialogTitle>
        <DialogDescription>{subject.label}</DialogDescription>
      </DialogHeader>
      <div className="px-6 pb-6">
        {options.isPending ? (
          <Skeleton shape="card" className="h-40 w-full" />
        ) : options.isError ? (
          <LaunchUnavailable subject={subject} message={options.error.message} onRetry={() => void options.refetch()} />
        ) : (
          <Composer subject={subject} options={options.data} starter={starter} onDone={onDone} />
        )}
      </div>
    </>
  );
}

function LaunchUnavailable({
  subject,
  message,
  onRetry,
}: {
  subject: LaunchSubject;
  message: string;
  onRetry: () => void;
}) {
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
        <Button size="sm" variant="ghost" onClick={subject.copyPrompt}>
          Copy prompt instead
        </Button>
      </div>
    </div>
  );
}

function Composer({
  subject,
  options,
  starter,
  onDone,
}: {
  subject: LaunchSubject;
  options: T3LaunchOptions;
  starter: Starter;
  onDone: () => void;
}) {
  const { promptFor } = subject;
  const [planWithMe, setPlanWithMe] = useState(subject.initialPlan);
  const [prompt, setPrompt] = useState(() => promptFor(planWithMe));
  const [selection, setSelection] = useState<T3ModelSelection | null>(() => launchModelSelection(options, planWithMe));
  const provider = options.providers.find((p) => p.instanceId === selection?.instanceId);
  const [runtimeMode, setRuntimeMode] = useState(() => clampRuntimeMode(options.defaults.runtimeMode, provider));
  const [choice, setChoice] = useState<WorkspaceChoice>(() =>
    initialWorkspaceChoice(options, subject.integrationBranch ?? null),
  );
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const t3 = useBoard().data?.integrations.t3;
  const settings = useSettings().data;

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
    starter.start(
      {
        commandId,
        prompt,
        modelSelection: selection,
        runtimeMode,
        workspace,
      },
      {
        onSuccess: (thread) => {
          const open = subject.offerOpen && t3 && thread ? t3LinkTargets(thread, t3, settings).primary : null;
          toastManager.add({
            type: "success",
            title: "Started in T3 Code",
            description: subject.successDescription,
            ...(open ? { actionProps: { children: "Open thread", onClick: () => openHref(open.href) } } : {}),
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
          {subject.planToggle ? (
            <ComposerControl
              aria-pressed={planWithMe}
              onClick={togglePlan}
              title="The agent shapes the plan with you before any code is written"
            >
              <LightbulbIcon />
              <span>Plan with me</span>
            </ComposerControl>
          ) : null}
          <button
            type="submit"
            aria-label="Start thread"
            title={blocker ?? "Start thread (Ctrl+Enter)"}
            disabled={!!blocker || starter.isPending || !prompt.trim()}
            className={cn(
              "ms-auto flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
            )}
          >
            {starter.isPending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </button>
        </div>
      </div>
      <div className="-mt-3 flex items-center justify-between rounded-b-xl border border-t-0 border-border bg-muted/30 px-2 pt-4 pb-1.5">
        <WorkspaceMenu options={options} choice={choice} onChange={setChoice} />
        <RefPicker options={options} choice={choice} onChange={setChoice} />
      </div>
      {subject.fixBranch ? (
        <FixBranchNote
          branch={subject.fixBranch}
          startsFrom={workspace?.mode === "new_worktree" ? workspace.baseRef : null}
        />
      ) : null}
      {options.suggestion ? <SuggestionNote suggestion={options.suggestion} planWithMe={planWithMe} /> : null}
    </form>
  );
}

/**
 * Says the thread works on a PR's branch, and warns when its worktree doesn't start from it (T3 listed no such ref, or
 * another was chosen): the prompt then has the agent fetch and fast-forward, and the push is refused if it can't.
 */
function FixBranchNote({ branch, startsFrom }: { branch: string; startsFrom: string | null }) {
  const onBranch = startsFrom === branch || startsFrom === `origin/${branch}`;
  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Works on the PR's branch {branch}</span>
      {onBranch ? " · the worktree starts from it." : null}
      {onBranch ? null : (
        <span className="block text-warning">
          The worktree doesn't start from it: pick origin/{branch} as the branch, or the agent has to fetch it first.
        </span>
      )}
    </p>
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
