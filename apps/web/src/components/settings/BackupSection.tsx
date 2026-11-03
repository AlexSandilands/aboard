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
import { BackupSetupDialog } from "./BackupSetupDialog";
import { backupState } from "./backupSetup.logic";
import { BlurInput } from "./BlurInput";
import { FolderPicker } from "./FolderPicker";
import { RestoreDialog } from "./RestoreDialog";
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
  const [restoring, setRestoring] = useState(false);
  const [setup, setSetup] = useState<"folder" | "github" | null>(null);
  const state = backupState(settings);
  const run = useMutation({
    mutationFn: () => api<BackupStatus>("/api/backup/run", { method: "POST", body: {} }),
    onSuccess: (next) => queryClient.setQueryData(queryKeys.backupStatus, next),
  });
  const intervals = INTERVALS.some((i) => i.value === settings.backupIntervalMinutes)
    ? INTERVALS
    : [...INTERVALS, { value: settings.backupIntervalMinutes, label: `${settings.backupIntervalMinutes} minutes` }];

  return (
    <SettingsSection id="board.data.backup" title="Backup">
      {state === "unconfigured" ? (
        <SettingsRow
          id="board.data.backup-setup"
          title="Set up backup"
          description="Pick a folder, connect a private GitHub repo and take the first backup."
          control={
            <Button size="sm" onClick={() => setSetup("folder")}>
              Set up backup
            </Button>
          }
        />
      ) : null}
      {state === "local_only" ? (
        <SettingsRow
          id="board.data.backup-local-only"
          title={<span className="text-warning-foreground">Local only: commits aren't pushed</span>}
          description="Backups stay in the folder below and nowhere else, so a lost disk loses them too."
          control={
            <Button size="sm" variant="outline" onClick={() => setSetup("github")}>
              Connect GitHub
            </Button>
          }
        />
      ) : null}
      {setup ? <BackupSetupDialog open startAt={setup} onOpenChange={(open) => !open && setSetup(null)} /> : null}
      <SettingsRow
        id="board.data.backup-enabled"
        title="Back up to git"
        description="Writes the board as JSON into a git repo and commits when it changes."
        info="Restore below, or from the command line with pnpm backup import."
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
        id="board.data.backup-folder"
        title="Folder"
        description={
          settings.backupDir ? (
            <span className="break-all font-mono">{settings.backupDir}</span>
          ) : (
            "An empty folder or an existing backup clone."
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
        id="board.data.backup-remote"
        title="Remote"
        description="Optional. Use a private repo."
        info="Task text stays in its history for good. Pushes use git's own sign-in. An empty folder becomes a clone of the remote."
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
        id="board.data.machine-name"
        title="Machine name"
        description="This machine's folder in the backup repo, so several machines can share one repo."
        info="Leave it blank to use the host name. Renaming moves the folder on the next backup; a name another machine already has is refused."
        control={
          <BlurInput
            aria-label="Machine name"
            size="sm"
            className="sm:w-64"
            // Blank while it follows the host name, which shows as the placeholder.
            placeholder={settings.machineName}
            value={settings.machineNameIsDefault ? "" : settings.machineName}
            onSave={(next) => updateSettings.mutate({ machineName: next.trim() || null })}
          />
        }
      />
      <SettingsRow
        id="board.data.backup-interval"
        title="Every"
        description="How often to check for changes."
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
        id="board.data.backup-last"
        title="Last backup"
        description={<BackupStatusLine status={status.data} remote={settings.backupRemote} />}
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
      <SettingsRow
        id="board.data.backup-restore"
        title="Restore"
        description="Bring back tasks, or the whole board, from any backup commit."
        info="Reads the commit beside the backup clone, which stays as it is. Replacing the whole board keeps a copy of it first."
        control={
          <Button size="sm" variant="outline" disabled={!settings.backupDir} onClick={() => setRestoring(true)}>
            Restore…
          </Button>
        }
      />
      <RestoreDialog open={restoring} onClose={() => setRestoring(false)} />
    </SettingsSection>
  );
}

function BackupStatusLine({ status, remote }: { status: BackupStatus | undefined; remote: string | null }) {
  if (!status?.lastRunAt) return "Not backed up since the server started.";
  const parts = [
    `Ran ${formatRelativeTimeLabel(status.lastRunAt)}`,
    status.lastCommit && status.lastCommitAt
      ? `committed ${status.lastCommit} ${formatRelativeTimeLabel(status.lastCommitAt)}`
      : null,
    pushPart(status, remote),
  ].filter(Boolean);
  return (
    <span className="flex flex-col gap-1">
      <span>{parts.join(" · ")}</span>
      {status.lastError ? <span className="break-words text-destructive-foreground">{status.lastError}</span> : null}
    </span>
  );
}

/** Where the last push stands: "pushed 5 min ago", "not pushed yet", or "not pushed: local only" without a remote. */
function pushPart(status: BackupStatus, remote: string | null): string {
  if (!remote) return "not pushed: local only";
  return status.lastPushAt
    ? `pushed ${formatRelativeTimeLabel(status.lastPushAt)}`
    : "not pushed since the server started";
}
