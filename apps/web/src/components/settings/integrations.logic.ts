import { gitHostDefinition, type GitHostStatus, type ModelPricesStatus, type TerminalInfo } from "@repo/contracts";

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

/** The model prices' dot: LiteLLM's list in use is ready, the built-in table because of a failure warns. */
export function modelPricesDot(status: ModelPricesStatus | undefined): IntegrationDot {
  if (!status) return dot("muted", "Checking");
  if (status.status === "off") return dot("muted", "Off");
  if (status.source === "built_in") return dot("warning", "LiteLLM's list unavailable");
  return dot(status.lastFailedAt ? "warning" : "success", status.lastFailedAt ? "Last fetch failed" : "Ready");
}

/**
 * The status row's line: which prices estimates use, since when, and a failed fetch. `relative` turns an instant into
 * "3h ago" (injected so tests don't depend on the clock).
 */
export function modelPricesLine(status: ModelPricesStatus, relative: (iso: string) => string): string {
  if (status.status === "off") return `Estimates use the board's built-in prices (as of ${status.asOf}).`;
  const failed = status.lastFailedAt ? ` The last fetch failed ${relative(status.lastFailedAt)}.` : "";
  if (status.source === "built_in") {
    return `Nothing fetched yet, so estimates use the board's built-in prices (as of ${status.asOf}).${failed}`;
  }
  const models = status.models === null ? "" : ` for ${status.models} models`;
  return `LiteLLM's prices${models}, fetched ${relative(status.asOf)}.${failed}`;
}
