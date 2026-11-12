import { closeAppWindow } from "~/components/layout/AppRouteModal";
import { taskHomeIsPanel } from "~/lib/windowZoom";
import { leaveCloses } from "~/lib/windowZoom.logic";

// How the task window is left, apart from the window itself so that the task's menus can dock it (`TaskMenuItems`
// is rendered inside the window).

/**
 * How the window is being left when that was said explicitly: `close` by `closeTaskWindow`, `dock` by
 * `dockTaskWindow`. Null (Esc, the backdrop) goes back where the task came from: the docked panel, or the board.
 */
let leaving: "close" | "dock" | null = null;

function leave(how: "close" | "dock"): boolean {
  leaving = how;
  if (closeAppWindow()) return true;
  leaving = null;
  return false;
}

/**
 * Closes the open task from the task window, after the window has animated out: its Close button, a delete, and
 * `panel.toggle`. False when no window is open.
 */
export const closeTaskWindow = (): boolean => leave("close");

/**
 * Docks the open task from the task window, after the window has animated out: its Dock button, the menu's Dock to
 * the side and `panel.expand`. False when no window is open.
 */
export const dockTaskWindow = (): boolean => leave("dock");

/** Whether leaving `taskId`'s window now closes the task rather than docking it. */
export const taskWindowLeaveCloses = (taskId: string): boolean => leaveCloses(leaving, taskHomeIsPanel(taskId));

/** Forgets how the window was being left: once it has gone, and when a new one mounts. */
export function resetTaskWindowLeave() {
  leaving = null;
}
