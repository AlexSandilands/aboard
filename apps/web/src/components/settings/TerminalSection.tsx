import { TerminalOpenIn, TerminalSetting, type AppSettings } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useUpdateSettings } from "~/state/mutations";
import { queryKeys, useTerminalInfo } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { terminalDot } from "./integrations.logic";
import { CommandSnippet, SettingsRow, SettingsSection, StatusDot } from "./settingsLayout";
import { terminalOptions, terminalOptionValue, terminalSettingFor } from "./terminal.logic";

const OPEN_IN_ITEMS: { value: TerminalOpenIn; label: string }[] = [
  { value: "tab", label: "New tab in the last window" },
  { value: "window", label: "New window" },
];

/** Where "Open in terminal" resumes agent sessions, with what it would run. */
export function TerminalSection({ settings }: { settings: AppSettings }) {
  const info = useTerminalInfo().data;
  const queryClient = useQueryClient();
  const updateSettings = useUpdateSettings();
  const options = terminalOptions(info);
  const save = (terminal: TerminalSetting) =>
    updateSettings.mutate(
      { terminal },
      { onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.terminal }) },
    );

  return (
    <SettingsSection
      id="integrations.terminal.status"
      title="Terminal"
      status={<StatusDot tone={terminalDot(info).tone} label={terminalDot(info).label} />}
    >
      <SettingsRow
        id="integrations.terminal.terminal"
        title="Open sessions in"
        description="Where Open in terminal resumes a linked Claude Code or Copilot CLI session. Automatic uses Windows Terminal's default profile on Windows, Terminal on macOS and the system terminal on Linux."
        control={
          <Select
            items={options.map((o) => ({ value: o.value, label: o.label }))}
            value={terminalOptionValue(settings.terminal)}
            onValueChange={(value) => {
              const next = typeof value === "string" ? terminalSettingFor(value, settings.terminal) : null;
              if (next) save(next);
            }}
          >
            <SelectTrigger size="sm" className="sm:w-64" aria-label="Terminal">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  <span className="truncate">{o.label}</span>
                  {o.detail ? <span className="ms-2 shrink-0 text-xs text-muted-foreground">{o.detail}</span> : null}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {info?.platform === "win32" &&
      (settings.terminal.kind === "auto" || settings.terminal.kind === "windows-terminal") ? (
        <SettingsRow
          id="integrations.terminal.open-in"
          title="Open in"
          description="Windows Terminal only: a new tab in the window you used last (a new window if none is open), or always a new window. Command Prompt, PowerShell and custom commands always open as their command says."
          control={
            <Select
              items={OPEN_IN_ITEMS}
              value={settings.terminalOpenIn}
              onValueChange={(value) => {
                const parsed = TerminalOpenIn.safeParse(value);
                if (parsed.success) {
                  updateSettings.mutate(
                    { terminalOpenIn: parsed.data },
                    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.terminal }) },
                  );
                }
              }}
            >
              <SelectTrigger size="sm" className="sm:w-64" aria-label="Open in">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {OPEN_IN_ITEMS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {settings.terminal.kind === "custom" ? (
        <SettingsRow
          id="integrations.terminal.command"
          title="Command"
          description="One command line, run by cmd on Windows and sh elsewhere. {cwd} is the session's folder, quoted; {command} is the resume command."
          control={
            <BlurInput
              key={settings.terminal.template}
              aria-label="Custom terminal command"
              size="sm"
              className="sm:w-80"
              value={settings.terminal.template}
              onSave={(next) => {
                const parsed = TerminalSetting.safeParse({ kind: "custom", template: next });
                if (parsed.success) save(parsed.data);
              }}
            />
          }
        />
      ) : null}
      <SettingsRow
        id="integrations.terminal.preview"
        title="Runs"
        description={info?.error ?? "What opening a session runs, for an example session in your home folder."}
      >
        {info?.preview ? <CommandSnippet command={info.preview} /> : null}
      </SettingsRow>
    </SettingsSection>
  );
}
