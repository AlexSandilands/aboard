import { createContext, useContext } from "react";
import type { TaskPanelLayout } from "./sections.logic";

/**
 * Where the task's details show, for the parts that read larger in the task window: document-size Markdown, inline
 * images, wider step notes and editors.
 */
export const TaskLayoutContext = createContext<TaskPanelLayout>("panel");

export const useTaskLayout = (): TaskPanelLayout => useContext(TaskLayoutContext);
