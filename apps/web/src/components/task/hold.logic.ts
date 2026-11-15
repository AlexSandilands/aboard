import type { TaskHold } from "@repo/contracts";

// A task a connected machine holds (docs/features/remote-machines.md#held-tasks): what its card and panel say.

/** The badge's text: where the task is, and how many edits made here the machine hasn't taken yet. */
export function holdLabel(hold: TaskHold): string {
  return hold.waiting > 0 ? `On ${hold.machineName} · ${hold.waiting} waiting` : `On ${hold.machineName}`;
}

/** The badge's tooltip. */
export function holdTitle(hold: TaskHold): string {
  const held = `${hold.machineName} holds this task and orders its changes; what you change here goes through it.`;
  if (hold.waiting === 0) return held;
  const edits = hold.waiting === 1 ? "1 change made here is" : `${hold.waiting} changes made here are`;
  return `${held} ${edits} waiting for it: shown already, applied once it can be reached, after what happened there.`;
}
