import type { GithubStatus, T3IntegrationStatus, TerminalInfo } from "@repo/contracts";
import type { ReviewCliCheck } from "~/state/mutations";

export type IntegrationTone = "success" | "warning" | "muted";

export interface IntegrationDot {
  tone: IntegrationTone;
  /** What the dot means, read out and shown on hover. */
  label: string;
}

const dot = (tone: IntegrationTone, label: string): IntegrationDot => ({ tone, label });

/** T3 Code: green once a saved token connects, amber when something is wrong, grey when it isn't set up. */
export function t3Dot(status: T3IntegrationStatus | undefined, tokenSet: boolean): IntegrationDot {
  if (!status) return dot("muted", "Checking");
  if (!status.detected) return dot("muted", "Not detected");
  if (!tokenSet) return dot("muted", "Detected, not connected");
  if (status.liveStatus === "error") return dot("warning", status.error ?? "Connection failed");
  return dot("success", status.liveStatus === "ok" ? "Connected" : "Token saved");
}

/** Claude Code: only known once its CLI has been tested on this page. */
export function claudeCodeDot(check: ReviewCliCheck | undefined): IntegrationDot {
  if (!check) return dot("muted", "CLI not tested");
  return check.ok ? dot("success", "CLI found") : dot("warning", "CLI not working");
}

export function githubDot(status: GithubStatus | undefined): IntegrationDot {
  if (!status) return dot("muted", "Checking");
  if (!status.available) return dot("warning", "gh not found");
  if (!status.authenticated) return dot("warning", "gh not signed in");
  if (status.hosts.some((host) => !host.authenticated)) return dot("warning", "A host's sign-in has expired");
  return dot("success", "Ready");
}

export function jiraDot(baseUrl: string | null): IntegrationDot {
  return baseUrl ? dot("success", "Base URL set") : dot("muted", "Not set up");
}

export function terminalDot(info: TerminalInfo | undefined): IntegrationDot {
  if (!info) return dot("muted", "Checking");
  return info.error ? dot("warning", info.error) : dot("success", "Ready");
}

/** Copilot and Codex are set up on their side with a snippet; the board can't tell whether they were. */
export const SNIPPET_DOT: IntegrationDot = dot("muted", "Set up from the snippet");
