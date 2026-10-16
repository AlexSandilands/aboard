import { nowIso } from "../db/database.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError } from "../errors.ts";
import type { Core, Effects } from "./core.ts";

export interface RelationsModule {
  /**
   * Makes each of `blockerRefs` (uuid, "#42" or "42") block the task, inside an existing write. Relations that
   * already exist are left alone. Throws VALIDATION for the task itself, an archived task, or a blocker that is
   * already blocked by this task, directly or through others (the error spells out the chain).
   */
  addBlockersIn(taskId: string, blockerRefs: readonly string[], actor: string, fx: Effects): void;
  /** Removes the given blockers, inside an existing write. Refs that aren't blockers are ignored. */
  removeBlockersIn(taskId: string, blockerRefs: readonly string[], actor: string, fx: Effects): void;
  /** Logs the deletion on the tasks a task relates to, so their cards drop it. Call before the task is deleted. */
  noteDeletionIn(task: TaskRecord, actor: string, fx: Effects): void;
}

/** "Blocks / blocked by" between tasks, across projects. The graph stays acyclic. */
export function createRelations(
  core: Core,
  deps: { resolveId: (ref: string) => string; record: (id: string) => TaskRecord },
): RelationsModule {
  const { repos } = core;
  const label = (task: TaskRecord): string => `#${task.number}`;

  return {
    addBlockersIn(taskId, blockerRefs, actor, fx) {
      const task = deps.record(taskId);
      for (const ref of blockerRefs) {
        const blocker = deps.record(deps.resolveId(ref));
        if (blocker.id === task.id) throw new AppError("VALIDATION", `${label(task)} cannot block itself`);
        if (blocker.archivedAt !== null || task.archivedAt !== null) {
          const archived = blocker.archivedAt !== null ? blocker : task;
          throw new AppError("VALIDATION", `${label(archived)} is archived; unarchive it first`);
        }
        // The new edge blocker -> task closes a loop when task already leads to blocker.
        const loop = repos.relations.path(task.id, blocker.id);
        if (loop) {
          const numbers = [...loop, task.id].map((id) => label(deps.record(id)));
          throw new AppError(
            "VALIDATION",
            `${label(blocker)} cannot block ${label(task)}: that would make a cycle (${numbers.join(" blocks ")}). ` +
              `Remove one of those relations first.`,
          );
        }
        if (!repos.relations.add(blocker.id, task.id, nowIso(), actor)) continue;
        fx.log(task.id, actor, "blocker_added", { task: blocker.number, title: blocker.title });
        fx.log(blocker.id, actor, "blocks_added", { task: task.number, title: task.title });
      }
    },

    removeBlockersIn(taskId, blockerRefs, actor, fx) {
      const task = deps.record(taskId);
      for (const ref of blockerRefs) {
        const blocker = deps.record(deps.resolveId(ref));
        if (!repos.relations.remove(blocker.id, task.id)) continue;
        fx.log(task.id, actor, "blocker_removed", { task: blocker.number, title: blocker.title });
        fx.log(blocker.id, actor, "blocks_removed", { task: task.number, title: task.title });
      }
    },

    noteDeletionIn(task, actor, fx) {
      for (const r of repos.relations.forTasks([task.id])) {
        const blocks = r.blockerId === task.id;
        fx.log(blocks ? r.blockedId : r.blockerId, actor, blocks ? "blocker_deleted" : "blocked_deleted", {
          task: task.number,
          title: task.title,
        });
      }
    },
  };
}
