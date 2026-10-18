import { BOARD_AGENTS_SNIPPET, type SkillSyncHarness, type SkillSyncStatus } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { api } from "~/lib/api";
import { queryKeys, useSkillSync } from "~/state/queries";
import { SettingsRow, StatusLine } from "./settingsLayout";
import { skillSyncBadge, skillSyncDescription, skillSyncDisablePrompt, snippetHint } from "./skillSync.logic";

type SkillSyncAction =
  | { harness: SkillSyncHarness; action: "enable" | "overwrite" }
  | { harness: SkillSyncHarness; action: "disable"; remove: boolean; force?: boolean };

/** Every action answers with the whole status, which replaces the cached one. */
function useSkillSyncAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SkillSyncAction) =>
      api<SkillSyncStatus>(`/api/skill-sync/${input.harness}/${input.action}`, {
        method: "POST",
        body: input.action === "disable" ? { remove: input.remove, force: input.force } : {},
      }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.skillSync, status),
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.skillSync });
      toastManager.add({
        type: "error",
        title: "Couldn't update the skill",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

/**
 * The Board skill row of a harness's section: a switch that installs the skill into the harness's global skills and
 * keeps it current, its state, and the choice to make when the user edited their copy.
 */
export function BoardSkillRow({ id, harness, title }: { id: string; harness: SkillSyncHarness; title: string }) {
  const skillSync = useSkillSync();
  const act = useSkillSyncAction();
  const [confirmOff, setConfirmOff] = useState(false);
  const status = skillSync.data?.harnesses.find((h) => h.harness === harness);
  const badge = status ? skillSyncBadge(status) : null;
  const prompt = status ? skillSyncDisablePrompt(status) : null;
  const edited = status?.enabled && status.state === "edited";

  const turnOff = (remove: boolean) => act.mutate({ harness, action: "disable", remove, force: remove });

  return (
    <SettingsRow
      id={id}
      title="Board skill"
      description={status ? skillSyncDescription(status) : "Checking the installed skill..."}
      info={`Teaches ${title} when to add to the backlog, write plans and update steps. A copy you edit is never overwritten without asking.`}
      status={badge ? <StatusLine badge={<Badge variant={badge.variant}>{badge.label}</Badge>} /> : null}
      control={
        <Switch
          aria-label={`Keep the board skill installed for ${title}`}
          checked={status?.enabled ?? false}
          disabled={!status || act.isPending}
          onCheckedChange={(checked) => {
            if (checked) act.mutate({ harness, action: "enable" });
            else if (prompt) setConfirmOff(true);
            else turnOff(false);
          }}
        />
      }
    >
      {edited ? (
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button size="xs" variant="ghost" disabled={act.isPending} onClick={() => turnOff(false)}>
            Keep mine
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={act.isPending}
            onClick={() => act.mutate({ harness, action: "overwrite" })}
          >
            Overwrite
          </Button>
        </div>
      ) : null}
      <Dialog open={confirmOff} onOpenChange={setConfirmOff}>
        <DialogPopup showCloseButton={false} className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Stop syncing the skill?</DialogTitle>
            <DialogDescription>{prompt?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              variant="outline"
              onClick={() => {
                turnOff(false);
                setConfirmOff(false);
              }}
            >
              Keep it
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                turnOff(true);
                setConfirmOff(false);
              }}
            >
              {prompt?.edited ? "Delete my copy" : "Delete it"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsRow>
  );
}

/** For agents without skills: the AGENTS.md snippet to copy, and whether it changed since the user last did. */
export function AgentsSnippetRow({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const skillSync = useSkillSync();
  const copied = useMutation({
    mutationFn: () => api<SkillSyncStatus>("/api/skill-sync/snippet-copied", { method: "POST", body: {} }),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.skillSync, status),
  });
  const hint = snippetHint(skillSync.data?.snippet);
  const changed = skillSync.data?.snippet.changedSinceCopied ?? false;
  return (
    <SettingsRow
      id={id}
      title="AGENTS.md snippet"
      description="For agents that don't read skills: paste it into your AGENTS.md."
      info="It lives in your own file, so the board can't keep it current. It tells you here when it changes."
      status={
        hint ? (
          <StatusLine badge={changed ? <Badge variant="warning">Changed</Badge> : undefined}>{hint}</StatusLine>
        ) : null
      }
      control={
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            // Recorded only once the clipboard has it, so a failed copy doesn't hide a later change.
            try {
              await navigator.clipboard.writeText(BOARD_AGENTS_SNIPPET);
            } catch {
              toastManager.add({ type: "error", title: "Couldn't copy snippet" });
              return;
            }
            toastManager.add({ type: "success", title: "Copied snippet" });
            copied.mutate();
          }}
        >
          Copy snippet
        </Button>
      }
    />
  );
}
