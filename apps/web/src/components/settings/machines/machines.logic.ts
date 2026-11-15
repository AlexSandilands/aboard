// Pure helpers for Settings › Integrations › Machines: what a machine's closed row says, and the sentences in it.
import type { Machine, MachineLogin, MachineRoute } from "@repo/contracts";
import type { StatusTone } from "../settingsLayout";

export type BadgeTone = "success" | "warning" | "error" | "info";

export interface MachineSummary {
  tone: StatusTone;
  /** "Connected over SSH", "Can't be reached", … */
  text: string;
  /** What is wrong or going on, named on the closed row. */
  badges: Array<{ tone: BadgeTone; label: string }>;
  /** Whether the row opens by itself: the machine needs something from the user. */
  attention: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A login the machine doesn't have. `unknown` isn't counted: the check failed, which says nothing of the login. */
export const loginMissing = (login: MachineLogin): boolean => login.state === "logged-out" || login.state === "missing";

/** Whether a route's URL is a Tailscale address (100.64.0.0/10) or MagicDNS name. */
function onTailnet(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const [a, b] = host.split(".").map(Number);
  return host.endsWith(".ts.net") || (a === 100 && b !== undefined && b >= 64 && b <= 127);
}

export function machineSummary(machine: Machine): MachineSummary {
  const route = machine.activeRoute === null ? undefined : machine.routes[machine.activeRoute];
  const via = route
    ? route.kind === "ssh"
      ? " over SSH"
      : onTailnet(route.url)
        ? " over Tailscale"
        : " directly"
    : "";
  const missing = (machine.logins ?? []).filter(loginMissing).length;
  const badges: MachineSummary["badges"] = [];
  if (machine.connection === "connected" && missing > 0) {
    badges.push({ tone: "warning", label: `${plural(missing, "login")} missing` });
  }
  const update = machine.update?.state;
  if (update === "waiting") badges.push({ tone: "info", label: "Update waiting" });
  if (update === "downloading" || update === "restarting") badges.push({ tone: "info", label: "Updating" });
  if (update === "failed") badges.push({ tone: "error", label: "Update failed" });

  const states: Record<Machine["connection"], [StatusTone, string]> = {
    connected: ["success", `Connected${via}`],
    connecting: ["muted", "Connecting"],
    unreachable: ["danger", "Can't be reached"],
    "needs-update": ["warning", "Needs updating"],
    unpaired: ["warning", "Not paired"],
  };
  const [tone, text] = states[machine.connection];
  const runs = machine.runsInFlight ? ` · ${plural(machine.runsInFlight, "run")}` : "";
  return {
    tone,
    text: `${text}${runs}`,
    badges,
    attention:
      machine.connection === "unreachable" ||
      machine.connection === "needs-update" ||
      machine.connection === "unpaired" ||
      missing > 0 ||
      update === "failed",
  };
}

/** How a login reads beside its name. */
export const LOGIN_WORDS: Record<MachineLogin["state"], string> = {
  ok: "Logged in",
  "logged-out": "Not logged in",
  missing: "Not installed",
  unknown: "Couldn't check",
};

/** The name a login is shown under: git's is about pushing. */
export const loginName = (login: MachineLogin): string => (login.name === "git" ? "git push" : login.name);

/** "40s", "2m", "1m 20s": how long until `at`, from `now`; "a moment" once it is due. */
export function untilLabel(at: string | null, now: number): string {
  const seconds = at === null ? 0 : Math.round((Date.parse(at) - now) / 1000);
  if (!(seconds > 0)) return "a moment";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

export interface VersionLine {
  badge: { tone: BadgeTone; label: string } | null;
  text: string;
  /** The button beside it, and whether it updates without waiting for runs. */
  action: { label: string; now: boolean; hint: string | null } | null;
}

/** The Version section's sentence: where the machine's version stands against the board's, and any update. */
export function versionLine(machine: Machine, boardVersion: string): VersionLine {
  const version = machine.version ?? "an unknown version";
  const runs = machine.runsInFlight ?? 0;
  const update = machine.update;
  if (update?.state === "waiting") {
    return {
      badge: { tone: "info", label: "Update waiting" },
      text:
        runs > 0
          ? `${version} → ${boardVersion} once its ${plural(runs, "run")} ${runs === 1 ? "finishes" : "finish"}.`
          : `${version} → ${boardVersion} once its runs finish.`,
      action: { label: "Update now", now: true, hint: "Ends the runs in flight." },
    };
  }
  if (update?.state === "downloading") {
    return { badge: { tone: "info", label: "Updating" }, text: `Downloading ${boardVersion}…`, action: null };
  }
  if (update?.state === "restarting") {
    return { badge: { tone: "info", label: "Updating" }, text: `Restarting on ${boardVersion}…`, action: null };
  }
  if (update?.state === "failed") {
    return {
      badge: { tone: "error", label: "Update failed" },
      text: `Still on ${version}. ${update.error ?? "The update failed."}`,
      action: { label: "Try again", now: false, hint: null },
    };
  }
  if (machine.versionState === "same") {
    return {
      badge: null,
      text: `${version}, the same as this board. Updates follow the board by themselves.`,
      action: null,
    };
  }
  if (machine.versionState === "newer") {
    return {
      badge: { tone: "warning", label: "Newer than this board" },
      text: `${version}; this board is ${boardVersion}. Update the board: a machine is never moved back a version.`,
      action: null,
    };
  }
  if (machine.versionState === "older") {
    if (machine.selfUpdate === false) {
      return {
        badge: { tone: "warning", label: "Behind this board" },
        text: `${version}; this board is ${boardVersion}. It wasn't installed by the install script, so it can't update itself: run the install command on it again.`,
        action: null,
      };
    }
    return {
      badge: { tone: "info", label: "Behind this board" },
      text: `${version}; this board is ${boardVersion}.`,
      action: { label: "Update", now: false, hint: "Waits for its runs to finish." },
    };
  }
  return { badge: null, text: "Not known until it has answered once.", action: null };
}

/** `routes` with the one at `index` moved one place up (`-1`) or down (`1`); unchanged at either end. */
export function moveRoute(routes: readonly MachineRoute[], index: number, by: -1 | 1): MachineRoute[] {
  const to = index + by;
  const next = [...routes];
  const moved = next[index];
  const other = next[to];
  if (!moved || !other) return next;
  next[index] = other;
  next[to] = moved;
  return next;
}

/** A direct route from what was typed: a full URL, or a bare address given `http://`. Null when it is neither. */
export function directRouteFrom(typed: string): MachineRoute | null {
  const text = typed.trim();
  if (text === "") return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    return url.hostname ? { kind: "direct", url: url.origin } : null;
  } catch {
    return null;
  }
}

/** The name a machine added over SSH will get when none is typed: the host part of the destination. */
export const nameFromTarget = (target: string): string => target.trim().split("@").pop() ?? "";
