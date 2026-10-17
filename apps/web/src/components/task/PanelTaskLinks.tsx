import { createContext, useContext, type ReactNode } from "react";
import type { TaskLinks } from "~/components/markdown/Markdown";
import { useTaskLinks } from "~/components/markdown/useTaskLinks";

const PanelTaskLinksContext = createContext<TaskLinks | undefined>(undefined);

/**
 * Builds the "#N" links once for the whole task panel. The rows inside it (every plan step, every activity entry) read
 * them with `usePanelTaskLinks` instead of each subscribing to the board and mapping its tasks.
 */
export function PanelTaskLinksProvider({ children }: { children: ReactNode }) {
  const taskLinks = useTaskLinks();
  return <PanelTaskLinksContext value={taskLinks}>{children}</PanelTaskLinksContext>;
}

/** The panel's "#N" links; undefined outside it, where "#N" stays text. */
export function usePanelTaskLinks(): TaskLinks | undefined {
  return useContext(PanelTaskLinksContext);
}
