import { z } from "zod";

// An agent session is a Claude Code or Copilot CLI conversation linked to a task, so the board can show whether it is
// still running and reopen it in a terminal. See docs/features/agent-sessions.md.

export const AgentHarness = z.enum(["claude-code", "copilot-cli"]);
export type AgentHarness = z.infer<typeof AgentHarness>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A drive path (`C:\…`), a UNC path (`\\server\…`) or a POSIX path (`/…`). */
export function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/.test(value);
}

export const AgentSessionRef = z.object({
  harness: AgentHarness,
  // The id goes into the resume command, so it must be exactly a UUID and nothing a shell could read more into.
  sessionId: z
    .string()
    .trim()
    .regex(UUID, "must be a UUID")
    .transform((id) => id.toLowerCase()),
  cwd: z.string().trim().min(1).refine(isAbsolutePath, "must be an absolute path"),
});
export type AgentSessionRef = z.infer<typeof AgentSessionRef>;

/**
 * Whether the session's process is alive, read from the harness's own files. busy and idle are Claude Code's;
 * Copilot CLI only says whether it is running. unknown: the files weren't where or what we expected.
 */
export const AgentSessionStatus = z.enum(["busy", "idle", "running", "not_running", "unknown"]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatus>;

export const AgentSessionSnapshot = z.object({
  status: AgentSessionStatus,
  /** Running inside an app on the Agent SDK (T3 Code) rather than in a terminal. */
  inApp: z.boolean(),
});
export type AgentSessionSnapshot = z.infer<typeof AgentSessionSnapshot>;

/** A session whose process is alive, so opening it again would run it twice. */
export const isRunningSession = (status: AgentSessionStatus | undefined): boolean =>
  status === "busy" || status === "idle" || status === "running";

export const ResumeMode = z.enum(["resume", "fork"]);
export type ResumeMode = z.infer<typeof ResumeMode>;

export interface HarnessInfo {
  label: string;
  /** The env var the harness puts its session id in, for agents to link their own session. */
  idEnvVar: string;
  cli: string;
  resumeArgs: (sessionId: string) => string[];
  /** Resumes into a new session that starts from this one's history; null when the harness can't. */
  forkArgs: ((sessionId: string) => string[]) | null;
}

export const AGENT_HARNESSES: Record<AgentHarness, HarnessInfo> = {
  "claude-code": {
    label: "Claude Code",
    idEnvVar: "CLAUDE_CODE_SESSION_ID",
    cli: "claude",
    resumeArgs: (id) => ["--resume", id],
    forkArgs: (id) => ["--resume", id, "--fork-session"],
  },
  "copilot-cli": {
    label: "Copilot CLI",
    idEnvVar: "COPILOT_AGENT_SESSION_ID",
    cli: "copilot",
    resumeArgs: (id) => [`--resume=${id}`],
    forkArgs: null,
  },
};

/** The command that resumes (or forks) a session, as argv. Throws when the harness can't fork. */
export function resumeArgv(ref: Pick<AgentSessionRef, "harness" | "sessionId">, mode: ResumeMode): string[] {
  const harness = AGENT_HARNESSES[ref.harness];
  const args = mode === "fork" ? harness.forkArgs?.(ref.sessionId) : harness.resumeArgs(ref.sessionId);
  if (!args) throw new Error(`${harness.label} sessions can't be forked`);
  return [harness.cli, ...args];
}

export const canFork = (harness: AgentHarness): boolean => AGENT_HARNESSES[harness].forkArgs !== null;

/** The synthetic URL an agent_session link is stored under: one link per harness and session. */
export const agentSessionUrl = (ref: Pick<AgentSessionRef, "harness" | "sessionId">): string =>
  `agent-session://${ref.harness}/${ref.sessionId.toLowerCase()}`;

// ── Terminal ─────────────────────────────────────────────────────────────

/**
 * Where "Open in terminal" runs the command. auto picks Windows Terminal's default profile on Windows, Terminal on
 * macOS and the system terminal on Linux. A custom template is one command line with {cwd} and {command} in it.
 */
export const TerminalSetting = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auto") }),
  /** A Windows Terminal profile by guid. */
  z.object({ kind: z.literal("windows-terminal"), profile: z.string().trim().min(1) }),
  z.object({ kind: z.literal("cmd") }),
  z.object({ kind: z.literal("powershell") }),
  z.object({
    kind: z.literal("custom"),
    template: z
      .string()
      .trim()
      .min(1)
      .refine((t) => t.includes("{command}"), "must contain {command}"),
  }),
]);
export type TerminalSetting = z.infer<typeof TerminalSetting>;

/** The shell a session is started in; it decides how the command is quoted and kept open. */
export const TerminalShell = z.enum(["bash", "cmd", "powershell", "pwsh", "sh"]);
export type TerminalShell = z.infer<typeof TerminalShell>;

export const WindowsTerminalProfile = z.object({
  guid: z.string(),
  name: z.string(),
  /** Null when the profile runs something we can't start a command in (WSL, Azure Cloud Shell); cmd is used. */
  shell: TerminalShell.nullable(),
});
export type WindowsTerminalProfile = z.infer<typeof WindowsTerminalProfile>;

/** `GET /api/terminal`: what auto resolves to here, the choices, and what the setting would run. */
export const TerminalInfo = z.object({
  platform: z.string(),
  /** A description of what auto picks, e.g. "Windows Terminal (Git Bash)". */
  autoLabel: z.string(),
  /** Windows Terminal's profiles, default first; empty when it isn't installed or this isn't Windows. */
  profiles: z.array(WindowsTerminalProfile),
  defaultProfile: z.string().nullable(),
  /** The command line the current setting runs for an example session. Null when it can't run here. */
  preview: z.string().nullable(),
  /** Why the current setting can't run here. */
  error: z.string().nullable(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const ResumeSessionInput = z.object({
  mode: ResumeMode.default("resume"),
  /** Open it even though the session is running. */
  force: z.boolean().default(false),
});
export type ResumeSessionInput = z.input<typeof ResumeSessionInput>;

/** What the copy action puts on the clipboard: change to the session's folder, then resume it. */
export const ResumeCommand = z.object({ command: z.string(), cwd: z.string() });
export type ResumeCommand = z.infer<typeof ResumeCommand>;

/** A launch that failed still returns the command, so it can be copied and run by hand. */
export const ResumeResult = z.object({
  launched: z.boolean(),
  command: z.string(),
  error: z.string().nullable(),
});
export type ResumeResult = z.infer<typeof ResumeResult>;
