import { gitHostDefinition, type GitHostStatus, type TerminalInfo } from "@repo/contracts";

export type IntegrationTone = "success" | "warning" | "muted";

export interface IntegrationDot {
  tone: IntegrationTone;
  /** What the dot means, read out and shown on hover. */
  label: string;
}

const dot = (tone: IntegrationTone, label: string): IntegrationDot => ({ tone, label });

/** A git host's dot: its CLI missing or signed out, or a host's sign-in expired, warns. */
export function gitHostDot(status: GitHostStatus | undefined): IntegrationDot {
  if (!status) return dot("muted", "Checking");
  const { cli } = gitHostDefinition(status.kind);
  if (!status.available) return dot("warning", `${cli.name} not found`);
  if (!status.authenticated) return dot("warning", `${cli.name} not signed in`);
  if (status.accounts.some((host) => !host.authenticated)) return dot("warning", "A host's sign-in has expired");
  return dot("success", "Ready");
}

export function terminalDot(info: TerminalInfo | undefined): IntegrationDot {
  if (!info) return dot("muted", "Checking");
  return info.error ? dot("warning", info.error) : dot("success", "Ready");
}
