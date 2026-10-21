import { useEffect } from "react";
import { usePrefetchSessionLaunchOptions, usePrefetchT3LaunchOptions } from "~/state/queries";

/**
 * Put inside a menu's popup, which only mounts while the menu is open: opening the menu starts loading the launch
 * options of the T3 dialog its "New T3 Code thread…" item opens, so the dialog rarely has to wait for them.
 */
export function PrefetchT3LaunchOptions(target: { taskId: string } | { projectId: string }) {
  const prefetch = usePrefetchT3LaunchOptions();
  const id = "taskId" in target ? target.taskId : target.projectId;
  const kind = "taskId" in target ? "task" : "project";
  useEffect(() => {
    prefetch(kind === "task" ? { taskId: id } : { projectId: id });
    // `prefetch` is a new function each render; the menu opening (this mounting) is what triggers it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [kind, id]);
  return null;
}

/** The same for the "New Claude Code / Copilot CLI session…" items: their dialog's options and the CLIs' models. */
export function PrefetchSessionLaunchOptions({ taskId }: { taskId: string }) {
  const prefetch = usePrefetchSessionLaunchOptions();
  useEffect(() => {
    prefetch(taskId);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- as above: the menu opening is the trigger
  }, [taskId]);
  return null;
}
