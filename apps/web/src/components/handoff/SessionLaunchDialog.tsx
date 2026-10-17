import {
  modelTierLabel,
  taskHandoffPrompt,
  taskWindowName,
  defaultHandoffMode,
  type AgentHarness,
  type PrFixInfo,
  type SessionLaunchOptions,
  type StartSessionResult,
  type TaskSummary,
} from "@repo/contracts";
import { AlertCircleIcon, ArrowUpIcon, LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { copyToClipboard } from "~/components/task/InlineInput";
import { Button } from "~/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { useStartSession } from "~/state/mutations";
import { useBoard, usePrFix, useSettings, useSessionLaunchOptions } from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { copyFixPrompt } from "./FixPrMenu";
import { copyHandoffPrompt } from "./HandoffActions";
import { ComposerControl } from "./T3LaunchPickers";
import {
  harnessLabel,
  initialModel,
  initialWhere,
  modelError,
  startedDescription,
  toSessionWorkspace,
  type SessionWhere,
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
      <DialogPopup className="max-w-2xl">
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
  const modelTiers = useSettings().data?.modelTiers;
  const pending = options.isPending || (!!fixLinkId && fix.isPending);
  const error = options.error ?? (fixLinkId ? fix.error : null);
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
        {pending ? (
          <Skeleton shape="card" className="h-40 w-full" />
        ) : error || !options.data ? (
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4 text-sm">
            <p className="flex items-start gap-2">
              <AlertCircleIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{error?.message ?? "Couldn't read the launch options"}</span>
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void options.refetch();
                  if (fixLinkId) void fix.refetch();
                }}
              >
                Retry
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  // A fix copies the fix prompt (read again, and its error shown), never the task's work prompt.
                  fixLinkId
                    ? void copyFixPrompt(fixLinkId)
                    : copyHandoffPrompt(task, defaultHandoffMode(task), modelTiers)
                }
              >
                Copy prompt instead
              </Button>
            </div>
          </div>
        ) : (
          <Composer
            task={task}
            harness={harness}
            options={options.data}
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
  fix,
  onDone,
}: {
  task: TaskSummary;
  harness: AgentHarness;
  options: SessionLaunchOptions;
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
  const [model, setModel] = useState(() => initialModel(options, harness, plan));
  const [where, setWhere] = useState<SessionWhere>(() => initialWhere(options, task.integrationBranch));
  const start = useStartSession({ silent: true });
  const cli = options.clis.find((c) => c.harness === harness);

  // A fix works on the PR's own branch, in a worktree of its own: there is no checkout to run it in.
  const workspace = fix
    ? options.isRepo
      ? { mode: "pr_branch" as const, branch: fix.branch }
      : null
    : toSessionWorkspace(where);
  const badModel = modelError(model);
  const blocker = !cli?.available
    ? `${harnessLabel(harness)} isn't installed`
    : !options.workspaceRoot
      ? "The project has no folder"
      : !workspace
        ? fix
          ? "The project's folder isn't a git repository"
          : "Choose a branch"
        : badModel;

  const togglePlan = () => {
    const next = !plan;
    // Swap what the dialog generated, but never discard what the user typed.
    if (prompt === promptFor(plan)) setPrompt(promptFor(next));
    if (model === initialModel(options, harness, plan)) setModel(initialModel(options, harness, next));
    setPlan(next);
  };

  const submit = () => {
    if (blocker || !workspace || !prompt.trim() || start.isPending) return;
    start.mutate(
      {
        taskId: task.id,
        harness,
        mode: fix ? "fix" : epic ? "orchestrate" : plan ? "plan" : "work",
        prompt,
        model: model.trim() || null,
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
          aria-label="First message"
          className="field-sizing-content block max-h-72 min-h-28 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <div className="flex min-w-0 items-center gap-1 px-2 pb-2">
          <Input
            size="sm"
            className="w-56"
            aria-label="Model"
            aria-invalid={badModel ? true : undefined}
            placeholder="Model (the CLI's default)"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
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
      <div className="-mt-3 flex items-center justify-between gap-2 rounded-b-xl border border-t-0 border-border bg-muted/30 px-2 pt-4 pb-1.5">
        {fix ? (
          <span className="truncate px-2 py-1 text-xs text-muted-foreground" title={options.workspaceRoot ?? undefined}>
            New worktree on the PR's branch <span className="font-mono text-foreground/80">{fix.branch}</span>
          </span>
        ) : (
          <>
            <Select
              items={WHERE_ITEMS}
              value={where.mode}
              disabled={!options.isRepo}
              onValueChange={(value) =>
                setWhere(
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
                onValueChange={(value) => setWhere({ mode: "new_worktree", baseRef: value })}
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
        )}
      </div>
      <p className="mt-2 px-1 text-xs text-muted-foreground">
        {options.tier && !plan ? (
          <span className="block">
            <span className="font-medium text-foreground">Suggested model: {modelTierLabel(options.tier)}</span>
            {options.models[harness]
              ? null
              : ` · no ${harnessLabel(harness)} model is set for this tier in Settings → Integrations`}
          </span>
        ) : null}
        {options.namedWindow
          ? `Opens in the Windows Terminal window ${taskWindowName(task.number)}, which the session's link brings back while it runs.`
          : "Opens in the terminal chosen in Settings → Integrations → Terminal."}
      </p>
    </form>
  );
}
