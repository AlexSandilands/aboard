import {
  AGENT_HARNESSES,
  MAX_PLAN_TASKS,
  planningSessionLabel,
  planTasksPrompt,
  type AgentHarness,
  type Project,
  type TaskSummary,
} from "@repo/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useState } from "react";
import { pickedAmong, plannableTasks } from "~/components/board/boardSelection.logic";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { copyToClipboard } from "~/components/task/InlineInput";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useStartPlanningSession } from "~/state/mutations";
import { useAgentClis, useBoard, useSettings } from "~/state/queries";
import { useBoardPick, useDialogs, type PlanTarget } from "~/state/ui";
import { planSkillOf } from "./handoff.logic";
import { AddImageControl, LaunchImageThumbs, useLaunchImages } from "./LaunchImages";
import { announceSession } from "./SessionLaunchDialog";
import { harnessLabel, modelError } from "./sessionLaunch.logic";

/** The planning prompt for these tasks, with the skill the project (or the board) chose. */
export function usePlanPrompt(project: Project, tasks: readonly TaskSummary[]) {
  const settings = useSettings().data;
  return (linked: boolean) =>
    planTasksPrompt({
      project,
      tasks,
      skill: planSkillOf(project, settings),
      boardUrl: window.location.origin,
      linked,
    });
}

const targetLabel = (target: PlanTarget): string =>
  target.kind === "t3"
    ? "Continue in T3 Code"
    : target.kind === "session"
      ? `Continue in ${harnessLabel(target.harness)}`
      : "Copy prompt";

/**
 * "Plan tasks…" from a lane header (useDialogs().openPlanPicker): the project's tasks a planning session can take,
 * the cards picked on the board ticked, then where the session starts.
 */
export function PlanTasksDialog() {
  const target = useDialogs((s) => s.planPicker);
  const close = useDialogs((s) => s.closePlanPicker);
  const project = useBoard().data?.projects.find((p) => p.id === target?.projectId);
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-lg">
        {project && target ? <Picker key={project.id} project={project} target={target.target} onDone={close} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function Picker({ project, target, onDone }: { project: Project; target: PlanTarget; onDone: () => void }) {
  const boardTasks = useBoard().data?.tasks;
  // Read once, so the list doesn't reorder or lose a row under the pointer while the board changes.
  const [tasks] = useState(() => plannableTasks(boardTasks ?? [], project.id));
  const [checked, setChecked] = useState(() => pickedAmong(useBoardPick.getState().picked, tasks));
  const chosen = tasks.filter((t) => checked.includes(t.id));
  const promptFor = usePlanPrompt(project, chosen);
  const tooMany = chosen.length > MAX_PLAN_TASKS;

  const toggle = (id: string) => setChecked((ids) => (ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]));

  const submit = () => {
    if (chosen.length === 0 || tooMany) return;
    const ids = chosen.map((t) => t.id);
    const dialogs = useDialogs.getState();
    if (target.kind === "t3") dialogs.openPlanT3Launch(project.id, ids);
    else if (target.kind === "session") dialogs.openPlanSession(project.id, ids, target.harness);
    else copyToClipboard(promptFor(false), "planning prompt");
    useBoardPick.getState().clearPicked();
    onDone();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Plan tasks</DialogTitle>
        <DialogDescription>
          One session walks you through a plan for each task you tick in {project.title}. Ctrl/⌘-click cards on the
          board to tick them here.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2 px-6">
        {tasks.length === 0 ? (
          <p className="rounded-xl border border-border bg-card/40 p-4 text-sm text-muted-foreground">
            No task here needs a plan: Backlog tasks and open tasks without a plan show up here.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {chosen.length} of {tasks.length} ticked
              </span>
              <Button size="xs" variant="ghost" className="ms-auto" onClick={() => setChecked(tasks.map((t) => t.id))}>
                Select all
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setChecked([])}>
                Select none
              </Button>
            </div>
            <ul className="flex max-h-80 flex-col overflow-y-auto rounded-xl border border-border/60 bg-card/40 p-1">
              {tasks.map((task) => (
                <li key={task.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/50">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-primary"
                      checked={checked.includes(task.id)}
                      onChange={() => toggle(task.id)}
                    />
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      #{task.number}
                    </span>
                    <span className="min-w-0 truncate">{task.title}</span>
                    {task.status !== "backlog" ? (
                      <span className="ms-auto shrink-0 text-xs text-muted-foreground">no plan</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            {tooMany ? <p className="text-xs text-warning">One session takes up to {MAX_PLAN_TASKS} tasks.</p> : null}
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button disabled={chosen.length === 0 || tooMany} onClick={submit}>
          {targetLabel(target)}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The new Claude Code / Copilot CLI session that plans the picked tasks (useDialogs().openPlanSession): the prompt to
 * edit and a model. It runs in the project's checkout, since planning writes no code.
 */
export function PlanSessionDialog() {
  const target = useDialogs((s) => s.planSession);
  const close = useDialogs((s) => s.closePlanSession);
  const board = useBoard().data;
  const project = board?.projects.find((p) => p.id === target?.projectId);
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && close()}>
      <DialogPopup className="max-w-2xl">
        {project && target ? (
          <PlanSession
            key={`${project.id}:${target.harness}`}
            project={project}
            tasks={target.taskIds.flatMap((id) => board?.tasks.find((t) => t.id === id) ?? [])}
            harness={target.harness}
            onDone={close}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function PlanSession({
  project,
  tasks: initialTasks,
  harness,
  onDone,
}: {
  project: Project;
  tasks: TaskSummary[];
  harness: AgentHarness;
  onDone: () => void;
}) {
  const [tasks] = useState(initialTasks);
  const promptFor = usePlanPrompt(project, tasks);
  const [prompt, setPrompt] = useState(() => promptFor(true));
  // Planning keeps the CLI's default model: a task's suggested tier is about implementing it.
  const [model, setModel] = useState("");
  const cli = useAgentClis().data?.find((c) => c.harness === harness);
  const start = useStartPlanningSession({ silent: true });
  const images = useLaunchImages();
  const badModel = modelError(model);
  const blocker = !cli?.available
    ? `${harnessLabel(harness)} isn't installed`
    : !project.workspaceRoot
      ? "The project has no folder"
      : (badModel ?? images.blocker);

  const submit = () => {
    if (blocker || !prompt.trim() || start.isPending) return;
    start.mutate(
      {
        projectId: project.id,
        harness,
        prompt,
        ...(images.ids.length > 0 ? { attachmentIds: images.ids } : {}),
        model: model.trim() || null,
        taskIds: tasks.map((t) => t.id),
      },
      {
        onSuccess: (result) => {
          announceSession(result, { harness, prompt, taskNumbers: tasks.map((t) => t.number) });
          onDone();
        },
        onError: (error) =>
          toastManager.add({ type: "error", title: "Couldn't start the session", description: error.message }),
      },
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <HarnessIcon harness={harness} className="size-4" />
          New {AGENT_HARNESSES[harness].label} planning session
        </DialogTitle>
        <DialogDescription>
          {planningSessionLabel(tasks)} · {project.title}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col px-6 pb-6"
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
            <Input
              size="sm"
              className="w-56"
              aria-label="Model"
              aria-invalid={badModel ? true : undefined}
              placeholder="Model (the CLI's default)"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <button
              type="submit"
              aria-label="Start session"
              title={blocker ?? "Start session (Ctrl+Enter)"}
              disabled={!!blocker || start.isPending || !prompt.trim()}
              className={cn(
                "ms-auto flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40",
              )}
            >
              {start.isPending ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
            </button>
          </div>
        </div>
        <div className="-mt-3 flex items-center gap-2 rounded-b-xl border border-t-0 border-border bg-muted/30 px-2 pt-4 pb-1.5">
          <span className="truncate px-2 py-1 text-xs text-muted-foreground" title={project.workspaceRoot ?? undefined}>
            Runs in this checkout: {project.workspaceRoot ?? "no project folder"}
          </span>
        </div>
      </form>
    </>
  );
}
