import { TerminalSetting, type AppSettings } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useUpdateSettings } from "~/state/mutations";
import { queryKeys, useTerminalInfo } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { CommandSnippet, SettingsRow, SettingsSection } from "./settingsLayout";
import { terminalOptions, terminalOptionValue, terminalSettingFor } from "./terminal.logic";

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
    <SettingsSection title="Terminal">
      <SettingsRow
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
      {settings.terminal.kind === "custom" ? (
        <SettingsRow
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
        title="Runs"
        description={info?.error ?? "What opening a session runs, for an example session in your home folder."}
      >
        {info?.preview ? <CommandSnippet command={info.preview} /> : null}
      </SettingsRow>
    </SettingsSection>
  );
}
