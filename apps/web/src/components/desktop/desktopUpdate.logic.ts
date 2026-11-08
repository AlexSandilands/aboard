// What Settings → Board → Desktop app says about the desktop app's updates, from the shell's update state.
import type { DesktopUpdateState } from "@repo/contracts";

export type UpdateBadgeTone = "success" | "info" | "error" | "outline";

export type UpdateAction = "check" | "install" | "notes" | null;

export interface UpdateStatusView {
  badge: { label: string; tone: UpdateBadgeTone } | null;
  /** The sentence beside the badge. */
  text: string;
  /** Download progress, 0-100, while downloading. */
  percent: number | null;
  /** The row's button: its label, and what it does (null: shown disabled). */
  button: { label: string; action: UpdateAction; primary: boolean };
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago". */
export function agoText(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function updateStatusView(state: DesktopUpdateState, now: number): UpdateStatusView {
  const check = { label: "Check now", action: "check" as const, primary: false };
  if (state.mode === "disabled") {
    return {
      badge: { label: "Off", tone: "outline" },
      text: `Updates are off in ${state.disabledReason ?? "this build"}; they only run in an installed release.`,
      percent: null,
      button: { ...check, action: null },
    };
  }
  switch (state.status) {
    case "idle":
      return {
        badge: null,
        text: state.autoCheck ? "Checks shortly after the app starts." : "Not checked yet.",
        percent: null,
        button: check,
      };
    case "checking":
      return {
        badge: { label: "Checking…", tone: "outline" },
        text: "",
        percent: null,
        button: { label: "Checking…", action: null, primary: false },
      };
    case "up-to-date":
      return {
        badge: { label: "Up to date", tone: "success" },
        text: state.checkedAt ? `Checked ${agoText(state.checkedAt, now)}.` : "",
        percent: null,
        button: check,
      };
    case "downloading":
      return {
        badge: { label: `v${state.version}`, tone: "info" },
        text: "Downloading in the background.",
        percent: state.percent ?? 0,
        button: { label: "Downloading…", action: null, primary: false },
      };
    case "ready":
      return {
        badge: { label: `v${state.version} ready`, tone: "info" },
        text: state.error
          ? `The update couldn't start: ${state.error}`
          : "Downloaded. Restarting takes a few seconds; agents reconnect by themselves.",
        percent: null,
        button: { label: "Restart to update", action: "install", primary: true },
      };
    case "installing":
      return {
        badge: { label: `v${state.version}`, tone: "info" },
        text: "Stopping the server and starting the installer…",
        percent: null,
        button: { label: "Restarting…", action: null, primary: true },
      };
    case "available":
      return {
        badge: { label: `v${state.version} available`, tone: "info" },
        text:
          state.noticeVia === "pacman"
            ? "Installed with pacman: update with pacman -Syu, or your AUR helper for the AUR package."
            : "Installed by a package: download the new one from the release page.",
        percent: null,
        button: { label: "Release notes", action: "notes", primary: false },
      };
    case "error":
      return {
        badge: { label: "Couldn't check", tone: "error" },
        text: state.error ?? "",
        percent: null,
        button: { ...check, label: "Try again" },
      };
  }
}
