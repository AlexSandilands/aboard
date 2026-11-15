import type { HostedRunnerStatus, UpdateHostedRunnerInput } from "@repo/contracts";
import type { StatusTone } from "../settingsLayout";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The line under "Let other machines run tasks here": whether the runner runs, and for whom. */
export function hostedRunnerLine(status: HostedRunnerStatus): { tone: StatusTone; label: string; text: string } {
  if (status.state === "failed") {
    return { tone: "danger", label: "Couldn't start", text: status.error ?? "The runner couldn't start." };
  }
  if (status.state === "starting") return { tone: "muted", label: "Starting", text: "Starting…" };
  if (status.state === "off") {
    return { tone: "muted", label: "Off", text: "Off. Nothing listens for other boards." };
  }
  const where = `Listening on port ${status.port}${status.tailscaleUrl ? " and on the tailnet" : ""}`;
  if (!status.board) return { tone: "warning", label: "Not paired", text: `${where}. No board is paired yet.` };
  const held = status.heldTasks > 0 ? `, holding ${plural(status.heldTasks, "task")}` : "";
  const runs = status.runsInFlight > 0 ? `, ${plural(status.runsInFlight, "run")} going` : "";
  return { tone: "success", label: "Running", text: `${where}. Runs tasks for ${status.board.name}${held}${runs}.` };
}

/** The addresses to give the other board with a code: the tailnet's when there is one, then this machine's own. */
export function pairingAddresses(code: { url: string; tailscaleUrl: string | null }): Array<{
  label: string;
  url: string;
}> {
  return code.tailscaleUrl
    ? [
        { label: "Over Tailscale", url: code.tailscaleUrl },
        { label: "At the far end of an SSH tunnel to this machine", url: code.url },
      ]
    : [{ label: "At the far end of an SSH tunnel to this machine", url: code.url }];
}

/**
 * What to ask before a change that stops or restarts the runner while it has runs going, which ends them; null when
 * nothing would be cut short.
 */
export function runsWarning(
  status: HostedRunnerStatus,
  change: UpdateHostedRunnerInput,
): { text: string; action: string } | null {
  if (status.state !== "running" || status.runsInFlight === 0) return null;
  const stops = change.enabled === false;
  const restarts = change.bind !== undefined && change.bind !== status.bind;
  if (!stops && !restarts) return null;
  const runs = plural(status.runsInFlight, "run");
  const owner = status.board?.name ?? "the other board";
  return {
    text: `${runs} for ${owner} ${status.runsInFlight === 1 ? "is" : "are"} going here. ${
      stops ? "Stopping" : "Restarting"
    } the runner ends ${status.runsInFlight === 1 ? "it" : "them"}.`,
    action: stops ? "Stop anyway" : "Restart anyway",
  };
}
