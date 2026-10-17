import { useSearch } from "@tanstack/react-router";
import { useEffect } from "react";
import { Board } from "~/components/board/Board";
import { useCloseTask, useProjectFilter, useSelectedTaskId } from "~/components/board/boardNavigation";
import { AppSidebar } from "~/components/sidebar/AppSidebar";
import { TaskPanel } from "~/components/task/TaskPanel";
import { useSettingsNav } from "~/state/ui";
import { AppShell } from "./AppShell";

/** Route component for "/": sidebar, board, and the `?task=` detail panel docked right. */
export function AppLayout() {
  const taskId = useSelectedTaskId();
  const closeTask = useCloseTask();
  const projectFilter = useProjectFilter();
  // Remembered so Settings' Back returns to this view, and its project page starts on the scoped project.
  const search = useSearch({ from: "/" });
  useEffect(() => useSettingsNav.getState().setBoardReturn(search), [search]);

  return (
    <AppShell
      sidebar={<AppSidebar />}
      sidebarLabel="Projects"
      onBack={taskId ? closeTask : null}
      newTaskProjectId={projectFilter}
    >
      <Board />
      {taskId ? <TaskPanel taskId={taskId} onClose={() => void closeTask()} /> : null}
    </AppShell>
  );
}
