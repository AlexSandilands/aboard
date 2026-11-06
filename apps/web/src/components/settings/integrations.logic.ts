import type { GithubStatus, TerminalInfo } from "@repo/contracts";

export type IntegrationTone = "success" | "warning" | "muted";

export interface IntegrationDot {
  tone: IntegrationTone;
  /** What the dot means, read out and shown on hover. */
  label: string;
}

const dot = (tone: IntegrationTone, label: string): IntegrationDot => ({ tone, label });

export function githubDot(status: GithubStatus | undefined): IntegrationDot {
  if (!status) return dot("muted", "Checking");
  if (!status.available) return dot("warning", "gh not found");
  if (!status.authenticated) return dot("warning", "gh not signed in");
  if (status.hosts.some((host) => !host.authenticated)) return dot("warning", "A host's sign-in has expired");
  return dot("success", "Ready");
}

export function terminalDot(info: TerminalInfo | undefined): IntegrationDot {
  if (!info) return dot("muted", "Checking");
  return info.error ? dot("warning", info.error) : dot("success", "Ready");
}
