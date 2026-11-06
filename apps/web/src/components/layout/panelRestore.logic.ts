/**
 * Whether the task panel being mounted is restored rather than opened, so it appears in place without sliding in.
 * Restored: the board is coming back from Settings or Stats on the task it left open (`boardReturn` is the board
 * search saved when it was left), or the app has just loaded on the board with `?task=`. Anything else (a task opened
 * from another page, a different task than the one left) is an opening and slides.
 */
export function panelRestored(taskId: string | null, boardReturnTask: string | undefined, firstLoad: boolean): boolean {
  if (!taskId) return false;
  return firstLoad || taskId === boardReturnTask;
}
