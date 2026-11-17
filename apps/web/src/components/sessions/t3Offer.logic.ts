// What a session error on a machine offers instead (docs/features/agent-sessions.md#on-a-machine): a T3 Code thread
// there, which needs no ssh, tmux or CLI on the board's side, or connecting that machine's T3 Code first.
import { MachineT3Offer, type Machine, type TaskHold } from "@repo/contracts";

export type T3OfferAction =
  | { kind: "start"; label: string; machineId: string }
  | { kind: "connect"; label: string; machineId: string };

/**
 * The action for an error's `details`: none unless they offer T3 Code on a machine that still holds the task (a
 * session's link outlives the hold, and a thread for a task the board holds would start in the board's own T3 Code).
 * A thread when that machine's T3 Code is connected; otherwise connecting it, read-only and not yet known included.
 */
export function t3OfferAction(
  details: unknown,
  hold: TaskHold | null | undefined,
  machine: Pick<Machine, "id" | "name" | "t3"> | null | undefined,
): T3OfferAction | null {
  const offer = MachineT3Offer.safeParse(details);
  if (!offer.success || !hold || hold.machineId !== offer.data.machineId) return null;
  const machineId = offer.data.machineId;
  if (machine?.id === machineId && machine.t3?.state === "connected") {
    return { kind: "start", label: "Start a T3 Code thread there", machineId };
  }
  const name = machine?.id === machineId ? machine.name : hold.machineName;
  return { kind: "connect", label: `Connect T3 Code on ${name}`, machineId };
}
