import { spawn, type ChildProcess } from "node:child_process";

// Ending a child process and everything it started, on every platform. Shared by `claude -p` runs and Autopilot's
// shell actions.

/**
 * Off Windows each run gets its own process group, so a timeout can end everything it started. Detached groups no
 * longer end with the server's terminal, so the ones still going are ended when the server exits.
 */
export const POSIX_GROUPS = process.platform !== "win32";
export const liveGroups = new Set<number>();
if (POSIX_GROUPS) {
  process.on("exit", () => {
    for (const pid of liveGroups) killGroup(pid);
  });
}

function killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Ends the process and everything it started: an agent's shells and test runs must not outlive a timeout. `force`
 * sends SIGKILL off Windows, for a tree that ignored the first attempt (taskkill /F is forced already).
 */
export function killTree(child: ChildProcess, force = false): void {
  if (child.pid === undefined) {
    child.kill();
  } else if (process.platform === "win32") {
    // child.kill() would end only the cmd.exe shim or claude itself, not the tools it started.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () =>
      child.kill(),
    );
  } else {
    killGroup(child.pid, force ? "SIGKILL" : "SIGTERM");
  }
}
