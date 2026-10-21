import {
  clampRuntimeMode,
  defaultHandoffMode,
  planningSessionLabel,
  suggestEpicsPrompt,
  taskNumberList,
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
import { useStartPlanningThread, useStartProjectT3Thread, useStartT3Thread } from "~/state/mutations";
import { useBoard, usePrFix, useProjectT3LaunchOptions, useSettings, useT3LaunchOptions } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import {
  keepsCommandId,
  findModel,
  initialPicks,
  selectionAfterPlanToggle,
  toLaunchWorkspace,
  type Picks,
} from "./handoff.logic";
import { copyHandoffPrompt, copySuggestEpicsPrompt } from "./HandoffActions";
import { AddImageControl, LaunchImageThumbs, useLaunchImages } from "./LaunchImages";
import { usePlanPrompt } from "./PlanTasksDialog";
import {
  AccessPicker,
  ComposerControl,
  ComposerStrip,
  ModelPicker,
  RefPicker,
  TraitsPicker,
  WorkspaceMenu,
} from "./T3LaunchPickers";

/**
 * What the dialog starts a thread for: a task, which the thread is linked to, a project's Suggest epics, or a plan
 * for several of a project's tasks, which the thread is linked to each of.
 */
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
  /** Starts in the project's checkout whatever T3's default: planning writes no code. */
  checkout?: boolean;
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
  const project =
    target?.kind === "project" || target?.kind === "plan"
      ? board?.projects.find((p) => p.id === target.projectId)
      : undefined;
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
        {project && target?.kind === "project" ? (
          <ProjectLaunch key={project.id} project={project} onDone={close} />
        ) : null}
        {project && target?.kind === "plan" ? (
          <PlanLaunch key={project.id} project={project} taskIds={target.taskIds} onDone={close} />
        ) : null}
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
  const modelSettings = useSettings().data;
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
        copyPrompt: () => copyHandoffPrompt(task, defaultHandoffMode(task), modelSettings),
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

function PlanLaunch({ project, taskIds, onDone }: { project: Project; taskIds: string[]; onDone: () => void }) {
  const options = useProjectT3LaunchOptions(project.id);
  const boardTasks = useBoard().data?.tasks;
  const mutation = useStartPlanningThread({ silent: true });
  // Read once: the prompt names these tasks, whatever happens to the board while the dialog is open.
  const [tasks] = useState(() => taskIds.flatMap((id) => boardTasks?.find((t) => t.id === id) ?? []));
  const promptFor = usePlanPrompt(project, tasks);
  const subject: LaunchSubject = {
    label: `${planningSessionLabel(tasks)} · ${project.title}`,
    promptFor: () => promptFor(true),
    planToggle: false,
    initialPlan: true,
    successDescription: `${taskNumberList(tasks)} ${tasks.length === 1 ? "is" : "are"} linked to the new thread.`,
    copyPrompt: () => copyToClipboard(promptFor(false), "planning prompt"),
    offerOpen: true,
    checkout: true,
  };
  const starter: Starter = {
    isPending: mutation.isPending,
    start: (input, { onSuccess, onError }) =>
      mutation.mutate(
        { projectId: project.id, taskIds: tasks.map((t) => t.id), ...input },
        {
          onSuccess: (links) => {
            const link = links[0];
            onSuccess(link?.kind === "t3_thread" ? link.ref : null);
          },
          onError,
        },
      ),
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
        {/* One element while the options load, fail and arrive, so what is typed meanwhile is kept. */}
        <Composer
          subject={subject}
          options={options.data}
          // Not once there are options: a failed background refresh must not make the dialog look broken.
          failure={
            !options.data && options.isError && !options.isFetching
              ? { message: options.error.message, onRetry: () => void options.refetch() }
              : null
          }
          starter={starter}
          onDone={onDone}
        />
      </div>
    </>
  );
}

function LaunchUnavailable({ message, onRetry, onCopy }: { message: string; onRetry: () => void; onCopy: () => void }) {
  return (
    <div className="mt-3 flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 text-sm">
      <p className="flex items-start gap-2">
        <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>{message}</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={onCopy}>
          Copy prompt instead
        </Button>
      </div>
    </div>
  );
}

function Composer({
  subject,
  options,
  failure,
  starter,
  onDone,
}: {
  subject: LaunchSubject;
  /** Undefined while they load: the prompt can be edited meanwhile, the rest waits for them. */
  options: T3LaunchOptions | undefined;
  /** Set when loading them failed: shown under the composer, which stays so the prompt isn't lost. */
  failure: { message: string; onRetry: () => void } | null;
  starter: Starter;
  onDone: () => void;
}) {
  const { promptFor } = subject;
  const [planWithMe, setPlanWithMe] = useState(subject.initialPlan);
  const [prompt, setPrompt] = useState(() => promptFor(planWithMe));
  // The choices start from the options. The dialog may open on cached ones that a refresh then changes (the task's
  // model, say), so until the user picks something they follow the newest; after that a refresh never moves them.
  const [picks, setPicks] = useState<Picks | null>(() => (options ? initialPicks(options, subject, planWithMe) : null));
  const [seededFrom, setSeededFrom] = useState(options);
  const [touched, setTouched] = useState(false);
  if (options && (!picks || (options !== seededFrom && !touched))) {
    setSeededFrom(options);
    setPicks(initialPicks(options, subject, planWithMe));
  }
  const ready = options && picks ? { options, ...picks } : null;
  // Kept or reset together: a retry with the same pair returns the same thread, images and all.
  const [launchIds, setLaunchIds] = useState(newLaunchIds);
  const images = useLaunchImages();
  const t3 = useBoard().data?.integrations.t3;
  const settings = useSettings().data;

  const selection = ready?.selection ?? null;
  const provider = options?.providers.find((p) => p.instanceId === selection?.instanceId);
  const workspace = ready ? toLaunchWorkspace(ready.options, ready.choice) : null;
  const model = options ? findModel(options, selection) : undefined;
  const blocker = !ready
    ? failure
      ? "The launch options didn't load"
      : "Loading the launch options"
    : !selection || !model?.provider.ready
      ? "Choose an available model"
      : !workspace
        ? "Choose a branch"
        : subject.fixBranch && workspace.mode !== "new_worktree"
          ? // The prompt has the agent fast-forward its branch to the PR's: that must never move one of yours.
            "Fix the PR in a new worktree, not in your checkout"
          : images.blocker;

  const pick = (patch: Partial<Picks>) => {
    setTouched(true);
    setPicks((current) => current && { ...current, ...patch });
  };
  const pickModel = (next: T3ModelSelection | null) => {
    setTouched(true);
    changeSelection(next);
  };
  const changeSelection = (next: T3ModelSelection | null) =>
    setPicks(
      (current) =>
        current && {
          ...current,
          selection: next,
          runtimeMode: clampRuntimeMode(
            current.runtimeMode,
            options?.providers.find((p) => p.instanceId === next?.instanceId),
          ),
        },
    );

  const togglePlan = () => {
    const next = !planWithMe;
    // Swap the generated prompt and the mode's model, but never discard the user's own choices.
    if (prompt === promptFor(planWithMe)) setPrompt(promptFor(next));
    // Still loading: the model is chosen from the options when they arrive, for the mode the dialog is then in.
    if (ready) changeSelection(selectionAfterPlanToggle(ready.options, ready.selection, next));
    setPlanWithMe(next);
  };

  const submit = () => {
    if (blocker || !ready || !selection || !workspace || !prompt.trim()) return;
    starter.start(
      {
        ...launchIds,
        prompt,
        ...(images.ids.length > 0 ? { attachmentIds: images.ids } : {}),
        modelSelection: selection,
        runtimeMode: ready.runtimeMode,
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
          if (error instanceof ApiError && !keepsCommandId(error.details)) setLaunchIds(newLaunchIds());
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
          {...images.handlers}
          aria-label="First message"
          className="field-sizing-content block max-h-72 min-h-28 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <LaunchImageThumbs state={images} />
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <AddImageControl state={images} />
          {ready ? (
            <>
              <ModelPicker options={ready.options} selection={ready.selection} onChange={pickModel} />
              {ready.selection ? (
                <TraitsPicker
                  options={ready.options}
                  selection={ready.selection}
                  onChange={(next) => pick({ selection: next })}
                />
              ) : null}
              <AccessPicker
                provider={provider}
                value={ready.runtimeMode}
                onChange={(runtimeMode) => pick({ runtimeMode })}
              />
            </>
          ) : failure ? null : (
            <ToolbarSkeleton />
          )}
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
      <ComposerStrip className="justify-between">
        {ready ? (
          <>
            <WorkspaceMenu options={ready.options} choice={ready.choice} onChange={(choice) => pick({ choice })} />
            <RefPicker options={ready.options} choice={ready.choice} onChange={(choice) => pick({ choice })} />
          </>
        ) : failure ? null : (
          <>
            <Skeleton className="my-1 h-4 w-28" />
            <Skeleton className="my-1 h-4 w-36" />
          </>
        )}
      </ComposerStrip>
      {failure && !options ? (
        // Copies what is in the box, edits included.
        <LaunchUnavailable
          message={failure.message}
          onRetry={failure.onRetry}
          onCopy={() => copyToClipboard(prompt, "prompt")}
        />
      ) : null}
      {subject.fixBranch ? (
        <FixBranchNote
          branch={subject.fixBranch}
          startsFrom={workspace?.mode === "new_worktree" ? workspace.baseRef : null}
        />
      ) : null}
      {options?.suggestion ? <SuggestionNote suggestion={options.suggestion} planWithMe={planWithMe} /> : null}
    </form>
  );
}

/** Stands in for the model, effort and access pickers while the options load. */
function ToolbarSkeleton() {
  return (
    <>
      <Skeleton shape="pill" className="mx-2.5 h-4 w-32" />
      <Skeleton shape="pill" className="mx-2.5 h-4 w-16" />
      <Skeleton shape="pill" className="mx-2.5 h-4 w-24" />
    </>
  );
}

/** The ids a launch is sent with; T3 de-duplicates by the command and files uploaded images under the thread. */
const newLaunchIds = () => ({ commandId: crypto.randomUUID(), threadId: crypto.randomUUID() });

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

/** The task's model (a custom model its label picks, else its suggested tier), and whether the dialog is using it. */
function SuggestionNote({ suggestion, planWithMe }: { suggestion: T3LaunchSuggestion; planWithMe: boolean }) {
  const status = planWithMe
    ? "Not used while planning."
    : suggestion.unavailable
      ? `${suggestion.unavailable} Using T3's default instead.`
      : null;
  return (
    <p className="mt-2 px-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">
        {suggestion.source === "label"
          ? `Model: ${suggestion.name}, from label ${suggestion.label}`
          : `Suggested model: ${suggestion.tier ?? suggestion.name}`}
      </span>
      {suggestion.reason ? ` · ${suggestion.reason}` : null}
      {status ? (
        <span className={cn("block", !planWithMe && suggestion.unavailable && "text-warning")}>{status}</span>
      ) : null}
    </p>
  );
}
