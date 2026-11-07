import type { AppSettings, TrashedTask } from "@repo/contracts";
import { useState } from "react";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { useNow } from "~/hooks/useNow";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { usePurgeTasks, useRestoreTasks, useUpdateSettings } from "~/state/mutations";
import { useBoard, useTrash } from "~/state/queries";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { retentionOptions, timeLeft } from "./trash.logic";

/** The trash: deleted tasks, each with Restore and Delete now, and how long they are kept. */
export function RecentlyDeletedSection({ settings }: { settings: AppSettings }) {
  const trash = useTrash();
  const projects = useBoard().data?.projects ?? [];
  const updateSettings = useUpdateSettings();
  const restore = useRestoreTasks();
  const purge = usePurgeTasks();
  const [purging, setPurging] = useState<TrashedTask | null>(null);
  const [shownPurge, setShownPurge] = useState(purging);
  if (purging && purging !== shownPurge) setShownPurge(purging);
  const options = retentionOptions(settings.trashRetentionDays);
  const tasks = trash.data ?? [];
  // Days left move slowly; a minute's tick keeps the rows honest while the page stays open.
  const now = useNow(60_000);

  return (
    <SettingsSection id="board.data.recently-deleted" title="Recently deleted">
      <SettingsRow
        id="board.data.trash-retention"
        title="Keep deleted tasks for"
        description="Then they are removed for good, with their plans, links and activity."
        control={
          <Select
            items={options}
            value={String(settings.trashRetentionDays)}
            onValueChange={(value) => {
              if (value) updateSettings.mutate({ trashRetentionDays: Number(value) });
            }}
          >
            <SelectTrigger size="sm" className="sm:w-32" aria-label="Keep deleted tasks for">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {tasks.length === 0 ? (
        <SettingsRow
          title={trash.error ? "Couldn't load deleted tasks" : "No deleted tasks"}
          description={trash.error ? trash.error.message : "Tasks you delete stay here until they expire."}
        />
      ) : null}
      {tasks.map((task) => {
        const project = projects.find((p) => p.id === task.projectId);
        const busy =
          (restore.isPending && restore.variables.includes(task.id)) ||
          (purge.isPending && purge.variables.includes(task.id));
        return (
          <SettingsRow
            key={task.id}
            title={
              <span className="flex min-w-0 gap-1.5">
                <span className="shrink-0 text-muted-foreground tabular-nums">#{task.number}</span>
                <span className="min-w-0 break-words">{task.title}</span>
              </span>
            }
            description={[
              project?.title,
              task.withEpic !== null ? `with epic #${task.withEpic}` : null,
              `deleted ${formatRelativeTimeLabel(task.deletedAt)}`,
              timeLeft(task.purgeAt, now.getTime()),
            ]
              .filter(Boolean)
              .join(" · ")}
            control={
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => restore.mutate([task.id])}>
                  Restore
                </Button>
                <Button size="sm" variant="destructive-outline" disabled={busy} onClick={() => setPurging(task)}>
                  Delete now
                </Button>
              </div>
            }
          />
        );
      })}
      <ConfirmDialog
        open={purging !== null}
        onOpenChange={(open) => !open && setPurging(null)}
        title={`Delete #${shownPurge?.number ?? ""} for good?`}
        description={
          shownPurge?.kind === "epic"
            ? "The epic and the tasks deleted with it are removed with their plans, links and activity. This can't be undone."
            : "It is removed with its plan, links and activity. This can't be undone."
        }
        confirmLabel="Delete now"
        onConfirm={() => {
          if (shownPurge) purge.mutate([shownPurge.id]);
        }}
      />
    </SettingsSection>
  );
}
