import { createContext, useContext } from "react";
import type { SectionColumn, TaskPanelLayout } from "./sections.logic";

/** Where a part of the task's details shows: the docked panel or the task window, and there which column, if split. */
export interface TaskLayout {
  layout: TaskPanelLayout;
  column?: SectionColumn;
}

export const TaskLayoutContext = createContext<TaskLayout>({ layout: "panel" });

export const useTaskLayout = (): TaskLayout => useContext(TaskLayoutContext);

/**
 * Whether a part reads at document size: document-size Markdown, inline images, wider step notes and editors. In the
 * task window, except its 21rem side column, which is narrower than the docked panel and reads at panel size.
 */
export function useReadsLarge(): boolean {
  const { layout, column } = useTaskLayout();
  return layout === "window" && column !== "rail";
}
