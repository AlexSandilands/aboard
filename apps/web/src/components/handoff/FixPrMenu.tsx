import {
  AGENT_HARNESSES,
  AUTOPILOT_FIX_PRS,
  prProblems,
  prRowSlot,
  type AgentHarness,
  type PrFixInfo,
  type PrRowSlot,
  type TaskLink,
  type TaskSummary,
} from "@repo/contracts";
import { ClipboardCopyIcon, MessageSquarePlusIcon } from "lucide-react";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { copyToClipboard } from "~/components/task/InlineInput";
import { MenuItem } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";
import {
  useAgentClis,
  useAutopilotEpicScope,
  useAutopilotRuns,
  useAutopilotScope,
  useBoard,
  useSettings,
} from "~/state/queries";
import { useDialogs } from "~/state/ui";
import { canStartT3Thread } from "./handoff.logic";
import { prAutopilotState } from "./fixPr.logic";

type PrLink = Extract<TaskLink, { kind: "pr" }>;
type SlotTask = Pick<
  TaskSummary,
  "id" | "kind" | "status" | "archivedAt" | "projectId" | "parent" | "attention" | "links"
>;

/**
 * The one action slot of a PR link's row, on the panel and on the card (`prRowSlot`): Merge, Fix in →, or what Autopilot's
 * Fix PRs is doing. Autopilot's scopes are only read while the PR has something to fix.
 */
export function usePrSlot(task: SlotTask, link: PrLink): PrRowSlot {
  const canFix = !!link.ref && task.kind !== "epic" && task.archivedAt === null;
  const needsFix = canFix && task.status !== "done" && prProblems(link.snapshot).length > 0;
  const project = useAutopilotScope(task.projectId, needsFix);
  const epic = useAutopilotEpicScope(task.projectId, task.parent?.id ?? "", needsFix && !!task.parent);
  const entry = (epic.data ?? project.data)?.find((e) => e.automation === AUTOPILOT_FIX_PRS);
  const fixOn = needsFix && (entry?.enabled ?? false);
  // Fix PRs' runs say whether it is at work on this PR; only read while it is on and the PR has a problem.
  const runs = useAutopilotRuns(fixOn ? { taskId: task.id } : null).data;
  const autopilot = fixOn
    ? prAutopilotState({
        fixOn,
        runs,
        task,
        linkId: link.id,
        attention: task.attention,
        prNumber: link.ref?.number,
      })
    : null;
  return prRowSlot({ taskStatus: task.status, snapshot: link.snapshot, canFix, autopilot });
}

/** Where "Fix in →" can start a session: T3 Code, and each CLI the board can start. */
function useFixInTargets(task: Pick<TaskSummary, "status" | "archivedAt" | "projectId">): {
  t3: boolean;
  clis: AgentHarness[];
} {
  const board = useBoard().data;
  const settings = useSettings().data;
  const clis = useAgentClis().data ?? [];
  const project = board?.projects.find((p) => p.id === task.projectId);
  return {
    t3: !!board && canStartT3Thread(task, project, board.integrations.t3, settings),
    clis: clis.filter((c) => c.available).map((c) => c.harness),
  };
}

/** Copies Fix PRs' prompt for the PR's problems now, for a session the board can't start. */
export async function copyFixPrompt(linkId: string) {
  try {
    const fix = await api<PrFixInfo>(`/api/links/${encodeURIComponent(linkId)}/fix`);
    copyToClipboard(fix.prompt, "fix prompt");
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't build the fix prompt",
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * What "Fix in →" offers: a T3 Code thread or a Claude Code / Copilot CLI session (each opens its launch dialog,
 * pre-filled with Fix PRs' prompt and working on the PR's own branch), or the prompt to paste into any other agent.
 */
export function FixInMenuItems({ task, link }: { task: SlotTask; link: PrLink }) {
  const { t3, clis } = useFixInTargets(task);
  return (
    <>
      {t3 ? (
        <MenuItem onClick={() => useDialogs.getState().openT3Launch(task.id, link.id)}>
          <MessageSquarePlusIcon />
          T3 Code thread…
        </MenuItem>
      ) : null}
      {clis.map((harness) => (
        <MenuItem key={harness} onClick={() => useDialogs.getState().openSessionLaunch(task.id, harness, link.id)}>
          <HarnessIcon harness={harness} />
          {AGENT_HARNESSES[harness].label} session…
        </MenuItem>
      ))}
      <MenuItem onClick={() => void copyFixPrompt(link.id)}>
        <ClipboardCopyIcon />
        Copy fix prompt
      </MenuItem>
    </>
  );
}
