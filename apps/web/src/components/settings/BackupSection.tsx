import type { AppSettings, BackupStatus } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { withTrailingSeparator } from "~/components/command/palette.logic";
import { Button } from "~/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { api } from "~/lib/api";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useUpdateSettings } from "~/state/mutations";
import { queryKeys, useBackupStatus } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { FolderPicker } from "./FolderPicker";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const INTERVALS = [
  { value: 15, label: "15 minutes" },
  { value: 60, label: "Hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "Day" },
] as const;

/** Scheduled backup of the board to a git repo: where, how often, and how the last run went. */
export function BackupSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();
  const status = useBackupStatus();
  const [browsing, setBrowsing] = useState(false);
  const run = useMutation({
    mutationFn: () => api<BackupStatus>("/api/backup/run", { method: "POST", body: {} }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.backupStatus, next),
  });
  const intervals = INTERVALS.some((i) => i.value === settings.backupIntervalMinutes)
    ? INTERVALS
    : [...INTERVALS, { value: settings.backupIntervalMinutes, label: `${settings.backupIntervalMinutes} minutes` }];

  return (
    <SettingsSection title="Backup">
      <SettingsRow
        title="Back up to git"
        description="Writes the board as JSON into a git repo and commits when it changes. Restore with pnpm backup import."
        control={
          <Switch
            aria-label="Back up to git"
            checked={settings.backupEnabled}
            disabled={!settings.backupDir}
            onCheckedChange={(checked) => updateSettings.mutate({ backupEnabled: checked })}
          />
        }
      />
      <SettingsRow
        title="Folder"
        description={
          settings.backupDir ? (
            <span className="break-all font-mono">{settings.backupDir}</span>
          ) : (
            "An empty folder (it becomes a clone of the remote) or an existing backup clone."
          )
        }
        control={
          browsing ? null : (
            <Button size="sm" variant="outline" onClick={() => setBrowsing(true)}>
              {settings.backupDir ? "Change" : "Choose"}
            </Button>
          )
        }
      >
        {browsing ? (
          <FolderPicker
            initialPath={settings.backupDir ? withTrailingSeparator(settings.backupDir) : "~/"}
            pending={updateSettings.isPending}
            onCancel={() => setBrowsing(false)}
            onPick={(path) => updateSettings.mutate({ backupDir: path }, { onSuccess: () => setBrowsing(false) })}
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Remote"
        description="Optional. Use a private repo: task text stays in its history for good. Pushes use git's own sign-in."
        control={
          <BlurInput
            aria-label="Backup remote"
            size="sm"
            className="sm:w-64"
            placeholder="https://github.com/org/board-backup.git"
            value={settings.backupRemote ?? ""}
            onSave={(next) => updateSettings.mutate({ backupRemote: next.trim() || null })}
          />
        }
      />
      <SettingsRow
        title="Every"
        description="How often to check for changes. A run with nothing new makes no commit."
        control={
          <Select
            items={intervals.map((i) => ({ value: String(i.value), label: i.label }))}
            value={String(settings.backupIntervalMinutes)}
            onValueChange={(value) => {
              if (value) updateSettings.mutate({ backupIntervalMinutes: Number(value) });
            }}
          >
            <SelectTrigger size="sm" className="sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {intervals.map((interval) => (
                <SelectItem key={interval.value} value={String(interval.value)}>
                  {interval.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Last backup"
        description={<BackupStatusLine status={status.data} />}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!settings.backupDir || run.isPending || status.data?.running}
            onClick={() => run.mutate()}
          >
            {run.isPending || status.data?.running ? "Backing up…" : "Back up now"}
          </Button>
        }
      >
        {run.error ? <p className="mt-2 text-xs text-destructive-foreground">{run.error.message}</p> : null}
      </SettingsRow>
    </SettingsSection>
  );
}

function BackupStatusLine({ status }: { status: BackupStatus | undefined }) {
  if (!status?.lastRunAt) return "Not backed up since the server started.";
  const parts = [
    `Ran ${formatRelativeTimeLabel(status.lastRunAt)}`,
    status.lastCommit && status.lastCommitAt
      ? `committed ${status.lastCommit} ${formatRelativeTimeLabel(status.lastCommitAt)}`
      : null,
    status.lastPushAt ? `pushed ${formatRelativeTimeLabel(status.lastPushAt)}` : null,
  ].filter(Boolean);
  return (
    <span className="flex flex-col gap-1">
      <span>{parts.join(" · ")}</span>
      {status.lastError ? <span className="break-words text-destructive-foreground">{status.lastError}</span> : null}
    </span>
  );
}
