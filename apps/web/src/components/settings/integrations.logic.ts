import type { AgentIntegrationStatus, GithubStatus, T3IntegrationStatus, TerminalInfo } from "@repo/contracts";

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

/**
 * A CLI harness (Claude Code, Copilot CLI): green when its CLI runs and the board's MCP server is registered with it,
 * amber with the reason when either is missing. Whether the harness reports the server as connected is detail, not a
 * condition: it can't always tell.
 */
export function agentDot(
  name: string,
  status: AgentIntegrationStatus | undefined,
  /** The request for the status failed, so there is none to wait for. */
  failed = false,
): IntegrationDot {
  if (!status) return failed ? dot("warning", `Couldn't check ${name}`) : dot("muted", "Checking");
  if (!status.cli.found) {
    return dot("warning", `${name} CLI not working${status.cli.error ? `: ${status.cli.error}` : ""}`);
  }
  if (!status.mcp.registered) return dot("warning", "MCP server not registered");
  // Added for one project only: `claude mcp list` can't confirm it, and it isn't there in other folders.
  if (status.mcp.scope === "local" && status.mcp.connected === null) {
    return dot("warning", "MCP server is registered for one project only: add it with --scope user");
  }
  if (status.mcp.connected === false) {
    return dot("success", `Ready, but ${name} reports the MCP server as not connected`);
  }
  return dot("success", "Ready");
}

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

/** Codex is set up on its side with a snippet; the board can't tell whether it was. */
export const SNIPPET_DOT: IntegrationDot = dot("muted", "Set up from the snippet");
