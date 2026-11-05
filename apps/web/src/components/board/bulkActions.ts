import type { CloseTaskInput, TaskStatus, TaskSummary } from "@repo/contracts";

import type { PickResolution } from "~/components/task/CloseTaskDialog";
import { copyToClipboard } from "~/components/task/InlineInput";
import { toastManager } from "~/components/ui/toast";
import { useMoveTask, useResolveTask, useUpdateTask } from "~/state/mutations";
import { bulkMove, bulkSummary, referenceList, type BulkMove } from "./bulkMenu.logic";

/** Runs `fn` on every task at once and counts how many the server took. */
async function runAll<T>(tasks: readonly T[], fn: (task: T) => Promise<unknown>) {
  const results = await Promise.allSettled(tasks.map(fn));
  const failed = results.filter((r) => r.status === "rejected").length;
  return { ok: results.length - failed, failed };
}

function toast(title: string, counts: { ok: number; skipped?: number; failed?: number }) {
  const problem = (counts.failed ?? 0) > 0 || counts.ok === 0;
  toastManager.add({ type: problem ? "warning" : "success", title });
  return counts;
}

/**
 * The card menu's bulk actions. Each runs the existing mutation once per task (so the optimistic move and its rollback
 * still work) and shows one summary toast instead of one per task: the mutations are silent, failures are counted.
 */
export function useBulkActions() {
  const { mutateAsync: moveTask } = useMoveTask({ silent: true });
  const { mutateAsync: updateTask } = useUpdateTask({ silent: true });
  const { mutateAsync: resolveTask } = useResolveTask({ silent: true });

  const move = async (tasks: readonly TaskSummary[], status: TaskStatus, label: string) => {
    const plan: BulkMove = bulkMove(tasks, status);
    // The plan gate is checked up front; a PLAN_REQUIRED the server still answers with (a plan deleted meanwhile) counts
    // with the rest as failed; the summary toast is the only one.
    const { ok, failed } = await runAll(plan.move, (t) => moveTask({ id: t.id, status }));
    const counts = { ok, skipped: plan.refused.length, failed };
    toast(
      bulkSummary((n) => `Moved ${n} to ${label}`, counts, "no plan"),
      counts,
    );
  };

  const setPriority = async (tasks: readonly TaskSummary[], on: boolean) => {
    const { ok, failed } = await runAll(tasks, (t) => updateTask({ id: t.id, priority: on }));
    toast(
      bulkSummary((n) => (on ? `Marked ${n} as priority` : `Removed priority from ${n}`), { ok, failed }),
      { ok, failed },
    );
  };

  // Off clears Autopilot and auto-merge to Default, which behaves the same and keeps the panel reading "Default".
  const setAutopilot = async (tasks: readonly TaskSummary[], on: boolean) => {
    const { ok, failed } = await runAll(tasks, (t) => updateTask({ id: t.id, autopilot: on ? true : null }));
    toast(
      bulkSummary((n) => `Turned Autopilot ${on ? "on" : "off"} for ${n}`, { ok, failed }),
      { ok, failed },
    );
  };

  const setAutoMerge = async (tasks: readonly TaskSummary[], on: boolean) => {
    const { ok, failed } = await runAll(tasks, (t) => updateTask({ id: t.id, autoMerge: on ? true : null }));
    toast(
      bulkSummary((n) => `Turned auto-merge ${on ? "on" : "off"} for ${n}`, { ok, failed }),
      { ok, failed },
    );
  };

  // Off is an explicit false: clearing to Default would leave auto-review on while the board's setting is on.
  const setAutoReview = async (tasks: readonly TaskSummary[], on: boolean) => {
    const { ok, failed } = await runAll(tasks, (t) => updateTask({ id: t.id, autoReview: on }));
    toast(
      bulkSummary((n) => `Turned auto-review ${on ? "on" : "off"} for ${n}`, { ok, failed }),
      { ok, failed },
    );
  };

  const archive = async (tasks: readonly TaskSummary[], archived: boolean) => {
    const { ok, failed } = await runAll(tasks, (t) => updateTask({ id: t.id, archived }));
    toast(
      bulkSummary((n) => `${archived ? "Archived" : "Unarchived"} ${n}`, { ok, failed }),
      { ok, failed },
    );
  };

  const setLabel = async (tasks: readonly TaskSummary[], label: string, mode: "add" | "remove") => {
    const { ok, failed } = await runAll(tasks, (t) =>
      updateTask({
        id: t.id,
        labels: mode === "add" ? [...t.labels, label] : t.labels.filter((l) => l !== label),
      }),
    );
    toast(
      bulkSummary((n) => (mode === "add" ? `Added “${label}” to ${n}` : `Removed “${label}” from ${n}`), {
        ok,
        failed,
      }),
      {
        ok,
        failed,
      },
    );
  };

  const closeAll = async (tasks: readonly { id: string }[], input: CloseTaskInput) => {
    const { ok, failed } = await runAll(tasks, (t) => resolveTask({ id: t.id, ...input }));
    toast(
      bulkSummary((n) => `Closed ${n}`, { ok, failed }),
      { ok, failed },
    );
    return failed === 0;
  };
  const wontDo = (tasks: readonly TaskSummary[]) => closeAll(tasks, { resolution: "wont_do" });
  /** Done by, or a duplicate of, `byTask`: true when every task was closed. */
  const closeAgainst = (tasks: readonly { id: string }[], resolution: PickResolution, byTask: string) =>
    closeAll(tasks, { resolution, byTask });

  const copyReferences = (tasks: readonly TaskSummary[]) => copyToClipboard(referenceList(tasks), "references");

  return {
    move,
    setPriority,
    setAutopilot,
    setAutoMerge,
    setAutoReview,
    archive,
    setLabel,
    wontDo,
    closeAgainst,
    copyReferences,
  };
}
