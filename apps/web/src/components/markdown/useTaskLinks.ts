import { useMemo } from "react";
import { taskIdsByNumber } from "~/components/digest/digest.logic";
import { useOpenTask } from "~/components/board/boardNavigation";
import { useBoard } from "~/state/queries";
import type { TaskLinks } from "./Markdown";

/**
 * Makes "#N" in Markdown a link to that task on the board: it opens in the panel and the board scrolls to its card.
 * `beforeOpen` runs first, for a dialog that has to close. Numbers of tasks the board doesn't have (archived ones
 * included) stay text.
 */
export function useTaskLinks(beforeOpen?: () => void): TaskLinks {
  const tasks = useBoard().data?.tasks;
  const openTask = useOpenTask();
  return useMemo<TaskLinks>(() => {
    const ids = taskIdsByNumber(tasks ?? []);
    return {
      isKnown: (number) => ids.has(number),
      onOpen: (number) => {
        const id = ids.get(number);
        if (!id) return;
        beforeOpen?.();
        void openTask(id);
      },
    };
  }, [tasks, openTask, beforeOpen]);
}
