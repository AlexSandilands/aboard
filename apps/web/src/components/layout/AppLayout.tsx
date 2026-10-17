import { useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { Board } from "~/components/board/Board";
import { useCloseTask, useSelectedTaskId } from "~/components/board/boardNavigation";
import { TaskPanel } from "~/components/task/TaskPanel";
import { useSettingsNav } from "~/state/ui";

/** Route component for "/": the board, and the `?task=` detail panel docked right. */
export function AppLayout() {
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  // Remembered so Settings' Back returns to this view, and its project page starts on the scoped project.
  const search = useSearch({ from: "/_app/" });
  useEffect(() => useSettingsNav.getState().setBoardReturn(search), [search]);

  return (
    <>
      <Board />
      {taskId ? <TaskPanel taskId={taskId} onClose={() => void closeTask()} /> : null}
    </>
  );
}
