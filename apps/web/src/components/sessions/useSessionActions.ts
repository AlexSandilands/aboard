import type { AgentSessionSnapshot, ResumeCommand, ResumeMode } from "@repo/contracts";
import { useCallback } from "react";
import { copyToClipboard } from "~/components/task/InlineInput";
import { toastManager } from "~/components/ui/toast";
import { api, ApiError } from "~/lib/api";
import { useResumeSession } from "~/state/mutations";
import { useDialogs } from "~/state/ui";
import type { SessionLink } from "./sessions.logic";

/** Copies the command that resumes a session by hand, as the server builds it for this machine's shell. */
export async function copyResumeCommand(linkId: string, mode: ResumeMode = "resume"): Promise<void> {
  try {
    const { command } = await api<ResumeCommand>(
      `/api/links/${encodeURIComponent(linkId)}/resume-command?mode=${mode}`,
    );
    copyToClipboard(command, "resume command");
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't build the resume command",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * "Open in terminal" for an agent session: a running session opens the warning dialog instead, and a terminal that
 * won't start leaves a toast with the command to copy.
 */
export function useSessionActions(taskId: string) {
  const resume = useResumeSession({ silent: true });
  const openWarning = useDialogs((s) => s.openSessionWarning);
  const { mutate } = resume;

  const open = useCallback(
    (link: SessionLink, mode: ResumeMode = "resume", force = false, onDone?: () => void) => {
      mutate(
        { linkId: link.id, mode, force },
        {
          onSuccess: (result) => {
            onDone?.();
            if (result.launched) return;
            const toastId = toastManager.add({
              type: "error",
              title: "Couldn't open a terminal",
              description: `${result.error ?? "The terminal didn't start."} Run the command yourself instead.`,
              actionProps: {
                children: "Copy command",
                onClick: () => {
                  toastManager.close(toastId);
                  copyToClipboard(result.command, "resume command");
                },
              },
            });
          },
          onError: (error) => {
            onDone?.();
            if (error instanceof ApiError && error.code === "CONFLICT") {
              openWarning({
                taskId,
                linkId: link.id,
                snapshot: (error.details as AgentSessionSnapshot | null) ?? null,
              });
              return;
            }
            toastManager.add({
              type: "error",
              title: "Couldn't open the session",
              description: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );
    },
    [mutate, openWarning, taskId],
  );

  return { open, pending: resume.isPending };
}
