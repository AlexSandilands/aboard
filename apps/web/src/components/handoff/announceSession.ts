import type { AgentHarness, StartSessionResult } from "@repo/contracts";
import { copyToClipboard } from "~/components/task/InlineInput";
import { toastManager } from "~/components/ui/toast";
import { harnessLabel, startedDescription } from "./sessionLaunch.logic";

/**
 * Toasts what starting a session did. A terminal that didn't open offers the command to run by hand; a CLI that got
 * the short prompt gets the full one on the clipboard (or a button to copy it, when the clipboard refuses).
 */
export function announceSession(
  result: StartSessionResult,
  {
    harness,
    prompt,
    taskNumbers,
    existingWorktree = false,
    title,
    notes = [],
  }: {
    harness: AgentHarness;
    prompt: string;
    taskNumbers: readonly number[];
    /** The session runs in a task's existing worktree rather than a new one. */
    existingWorktree?: boolean;
    /** Instead of "Started <CLI>": a custom hand-off's own title. */
    title?: string;
    /** Said after the description: what didn't go as a custom hand-off asked. */
    notes?: readonly string[];
  },
) {
  if (!result.launched) {
    const toastId = toastManager.add({
      type: "error",
      title: "Couldn't open a terminal",
      description: `${result.error ?? "The terminal didn't start."} Run the command yourself instead${result.branch ? `: it runs in ${existingWorktree ? "the task's worktree" : "the new worktree"} on ${result.branch}` : ""}.`,
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
      title: title ?? `Started ${harnessLabel(harness)}`,
      description: [
        result.shortReason,
        startedDescription(result, harness, taskNumbers, copied, existingWorktree),
        ...notes,
      ]
        .filter(Boolean)
        .join(" "),
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
