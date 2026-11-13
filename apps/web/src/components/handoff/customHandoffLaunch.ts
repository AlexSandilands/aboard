import {
  handoffTargetHarness,
  type AppSettings,
  type CustomHandoff,
  type StartCustomHandoffInput,
  type StartCustomHandoffResult,
  type T3IntegrationStatus,
  type TaskSummary,
} from "@repo/contracts";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";
import { openHref, t3LinkTargets } from "~/lib/t3Links";
import { useDialogs } from "~/state/ui";
import { startedHandoffNotes, startedHandoffTitle, startedThreadDescription } from "./customHandoffs.logic";
import { announceSession } from "./announceSession";

/** Opens the hand-off's launch dialog: its target's, with the prompt, model and workspace filled in. */
export function openCustomHandoffDialog(task: Pick<TaskSummary, "id">, handoff: CustomHandoff) {
  const harness = handoffTargetHarness(handoff.target);
  if (harness) useDialogs.getState().openSessionLaunch(task.id, harness, undefined, handoff);
  else useDialogs.getState().openT3Launch(task.id, undefined, handoff);
}

/**
 * Runs a custom hand-off from a task's menu: its dialog, or, for one that skips it, the launch itself with a toast
 * saying what started (or why it didn't, with the dialog one click away). A plain function rather than a mutation
 * hook: the menu that starts it has unmounted by the time the launch answers.
 */
export function runCustomHandoff(
  task: Pick<TaskSummary, "id" | "number">,
  handoff: CustomHandoff,
  context: LaunchContext,
): void {
  if (handoff.skipDialog) void startNow(task, handoff, context);
  else openCustomHandoffDialog(task, handoff);
}

/** What the "Open thread" action needs: where T3 Code is, and which of its links the user opens. */
interface LaunchContext {
  t3: T3IntegrationStatus | undefined;
  settings: Pick<AppSettings, "t3LinkTarget"> | undefined;
}

async function startNow(task: Pick<TaskSummary, "id" | "number">, handoff: CustomHandoff, context: LaunchContext) {
  const pending = toastManager.add({ type: "loading", title: `Starting “${handoff.name}”…`, timeout: 0 });
  const body: StartCustomHandoffInput = { boardUrl: window.location.origin, commandId: crypto.randomUUID() };
  let result: StartCustomHandoffResult;
  try {
    result = await api<StartCustomHandoffResult>(
      `/api/tasks/${encodeURIComponent(task.id)}/custom-handoffs/${encodeURIComponent(handoff.id)}`,
      { body },
    );
  } catch (error) {
    toastManager.close(pending);
    const toastId = toastManager.add({
      type: "error",
      title: `Couldn't start “${handoff.name}”`,
      description: error instanceof Error ? error.message : String(error),
      data: { actionLayout: "stacked-end" },
      actionProps: {
        children: "Open dialog",
        onClick: () => {
          toastManager.close(toastId);
          openCustomHandoffDialog(task, handoff);
        },
      },
    });
    return;
  }
  toastManager.close(pending);
  const harness = handoffTargetHarness(result.target);
  if (harness && result.session) {
    announceSession(result.session, {
      harness,
      prompt: result.prompt,
      taskNumbers: [task.number],
      existingWorktree: result.workspace === "task_worktree",
      title: startedHandoffTitle(result),
      notes: startedHandoffNotes(result, task.number),
    });
    return;
  }
  const thread = result.link?.kind === "t3_thread" ? result.link.ref : null;
  const open = thread && context.t3 ? t3LinkTargets(thread, context.t3, context.settings).primary : null;
  toastManager.add({
    type: result.fellBack || result.note ? "warning" : "success",
    title: startedHandoffTitle(result),
    description: startedThreadDescription(result, task.number),
    // Under the text: these say more than a line, and a button beside them leaves a narrow column.
    data: { actionLayout: "stacked-end" },
    ...(open ? { actionProps: { children: "Open thread", onClick: () => openHref(open.href) } } : {}),
  });
}
