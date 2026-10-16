import type { TerminalInfo, TerminalSetting } from "@repo/contracts";

export interface TerminalOption {
  value: string;
  label: string;
  detail?: string;
}

const SHELL_LABEL: Record<string, string> = {
  bash: "bash",
  cmd: "cmd",
  powershell: "PowerShell",
  pwsh: "PowerShell 7",
  sh: "sh",
};

/** The terminal choices on this machine: auto, Windows Terminal's profiles, cmd and PowerShell on Windows, custom. */
export function terminalOptions(info: TerminalInfo | undefined): TerminalOption[] {
  const windows = info?.platform === "win32";
  return [
    { value: "auto", label: "Automatic", ...(info ? { detail: info.autoLabel } : {}) },
    ...(info?.profiles ?? []).map((p) => ({
      value: `wt:${p.guid}`,
      label: `Windows Terminal: ${p.name}`,
      detail: p.shell ? SHELL_LABEL[p.shell] : "runs cmd",
    })),
    ...(windows
      ? [
          { value: "cmd", label: "Command Prompt" },
          { value: "powershell", label: "Windows PowerShell" },
        ]
      : []),
    { value: "custom", label: "Custom command" },
  ];
}

/** The select's value for a setting. */
export function terminalOptionValue(setting: TerminalSetting): string {
  return setting.kind === "windows-terminal" ? `wt:${setting.profile}` : setting.kind;
}

export const DEFAULT_CUSTOM_TEMPLATE = "wezterm start --cwd {cwd} -- {command}";

/** The setting a picked option means. A custom command keeps the template it had, if any. */
export function terminalSettingFor(value: string, current: TerminalSetting): TerminalSetting | null {
  if (value.startsWith("wt:")) return { kind: "windows-terminal", profile: value.slice(3) };
  switch (value) {
    case "auto":
    case "cmd":
    case "powershell":
      return { kind: value };
    case "custom":
      return { kind: "custom", template: current.kind === "custom" ? current.template : DEFAULT_CUSTOM_TEMPLATE };
    default:
      return null;
  }
}
