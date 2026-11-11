import {
  gitHostDefinition,
  type AppSettings,
  type BackupRemoteCheck,
  type BackupSetupInfo,
  type BackupStatus,
  type CreateBackupRepoResult,
  type UpdateSettingsInput,
} from "@repo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { withTrailingSeparator } from "~/components/command/palette.logic";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { api } from "~/lib/api";
import { cn } from "~/lib/utils";
import { queryKeys } from "~/state/queries";
import { withPendingSettingsWrites } from "~/state/settingsWrites";
import {
  createUnavailableReason,
  firstBackupOutcome,
  initialRemoteChoice,
  type RemoteChoice,
  type RemoteVerdict,
  remoteVerdict,
  suggestedRemote,
} from "./backupSetup.logic";
import { FolderPicker } from "./FolderPicker";

type Step = "folder" | "github" | "finish";

/**
 * Guided backup setup: a folder (the data dir's `backup` by default), then where it pushes (a new private repo made
 * with gh, an existing repo, or nowhere), then the first backup and how it went. "Connect GitHub" starts at the
 * second step for a backup that only commits locally. Mount it only while open, so each opening starts over.
 */
export function BackupSetupDialog({
  open,
  onOpenChange,
  startAt = "folder",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startAt?: "folder" | "github";
}) {
  const info = useQuery({
    queryKey: queryKeys.backupSetupInfo,
    queryFn: ({ signal }) => api<BackupSetupInfo>("/api/backup/setup-info", { signal }),
    enabled: open,
    staleTime: 0,
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{startAt === "github" ? "Connect GitHub" : "Set up backup"}</DialogTitle>
        </DialogHeader>
        {info.data ? (
          <SetupSteps
            info={info.data}
            startAt={startAt}
            onRecheck={() => void info.refetch()}
            rechecking={info.isFetching}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <DialogPanel>
            {info.error ? (
              <Alert variant="error">
                <AlertDescription>{info.error.message}</AlertDescription>
              </Alert>
            ) : (
              <Spinner />
            )}
          </DialogPanel>
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SetupSteps({
  info,
  startAt,
  onRecheck,
  rechecking,
  onClose,
}: {
  info: BackupSetupInfo;
  startAt: Step;
  onRecheck: () => void;
  rechecking: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>(startAt);
  const [dir, setDir] = useState(info.backupDir ?? info.defaultDir);
  const [browsing, setBrowsing] = useState(false);
  const [choice, setChoice] = useState<RemoteChoice>(initialRemoteChoice(info));
  const [repoName, setRepoName] = useState(info.suggestedRepoName);
  const [remoteUrl, setRemoteUrl] = useState(suggestedRemote(info));
  const [machineName, setMachineName] = useState(info.machineName);
  const [checked, setChecked] = useState<{ url: string; check: BackupRemoteCheck } | null>(null);
  const [created, setCreated] = useState<CreateBackupRepoResult | null>(null);
  const [outcome, setOutcome] = useState<RemoteVerdict | null>(null);

  const check = useMutation({
    mutationFn: (remote: string) =>
      api<BackupRemoteCheck>("/api/backup/check-remote", { method: "POST", body: { remote } }),
    onSuccess: (result, remote) => setChecked({ url: remote, check: result }),
  });
  const create = useMutation({
    mutationFn: (name: string) =>
      api<CreateBackupRepoResult>("/api/backup/github-repo", { method: "POST", body: { name } }),
    onSuccess: (result) => {
      setCreated(result);
      setStep("finish");
    },
  });
  const finish = useMutation({
    mutationFn: async () => {
      const remote = remoteOf();
      const patch: UpdateSettingsInput = { backupDir: dir.trim(), backupRemote: remote, backupEnabled: true };
      if (machineName.trim() !== info.machineName) patch.machineName = machineName.trim();
      const settings = await api<AppSettings>("/api/settings", { method: "PATCH", body: patch });
      queryClient.setQueryData(queryKeys.settings, withPendingSettingsWrites(queryClient, settings));
      const status = await api<BackupStatus>("/api/backup/run", { method: "POST", body: {} });
      queryClient.setQueryData(queryKeys.backupStatus, status);
      return firstBackupOutcome(status, remote);
    },
    onSuccess: setOutcome,
    // The run pins a default machine name, which the PATCH reply cached above doesn't know yet. Also on error: the
    // PATCH may have succeeded before the run failed.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
  });

  const remoteOf = (): string | null => {
    if (choice === "none") return null;
    if (choice === "create") return created?.remote ?? null;
    return remoteUrl.trim() || null;
  };
  const verdict = checked && checked.url === remoteUrl.trim() ? remoteVerdict(checked.check, machineName) : null;
  const createBlocked = createUnavailableReason(info);

  if (step === "folder") {
    return (
      <>
        <DialogPanel className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            The board is written into this folder as JSON and committed with git. An empty folder, or a clone of an
            existing backup repo.
          </p>
          {browsing ? (
            <FolderPicker
              initialPath={withTrailingSeparator(dir)}
              pending={false}
              onCancel={() => setBrowsing(false)}
              onPick={(path) => {
                setDir(path);
                setBrowsing(false);
              }}
            />
          ) : (
            <div className="flex gap-2">
              <Input aria-label="Backup folder" value={dir} onChange={(e) => setDir(e.currentTarget.value)} />
              <Button variant="outline" onClick={() => setBrowsing(true)}>
                Browse
              </Button>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!dir.trim() || browsing} onClick={() => setStep("github")}>
            Next
          </Button>
        </DialogFooter>
      </>
    );
  }

  if (step === "github") {
    const host = gitHostDefinition(info.host.kind);
    const canContinue =
      choice === "none" || (choice === "create" ? !createBlocked && repoName.trim() : Boolean(verdict?.ok));
    return (
      <>
        <DialogPanel className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Push the backups to a private repo so they live off this machine. Pushes use git's own sign-in; the board
            stores no token.
          </p>
          <ChoiceButton
            selected={choice === "create"}
            disabled={Boolean(createBlocked)}
            onSelect={() => setChoice("create")}
            title={`Create a private ${host.label} repo`}
            description={
              createBlocked ?? `With ${host.cli.name}, as ${info.host.login ?? `your ${host.label} account`}.`
            }
          >
            {choice === "create" ? (
              <Input aria-label="Repo name" value={repoName} onChange={(e) => setRepoName(e.currentTarget.value)} />
            ) : null}
          </ChoiceButton>
          {createBlocked ? (
            <Button className="self-start" size="sm" variant="outline" disabled={rechecking} onClick={onRecheck}>
              {rechecking ? "Checking…" : `Check ${host.cli.name} again`}
            </Button>
          ) : null}
          <ChoiceButton
            selected={choice === "existing"}
            onSelect={() => setChoice("existing")}
            title="Use an existing repo"
            description="A backup repo another machine pushes to, or a new empty one. Paste its URL."
          >
            {choice === "existing" ? (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Input
                    aria-label="Repo URL"
                    placeholder="https://github.com/you/board-backup.git"
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.currentTarget.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={!remoteUrl.trim() || check.isPending}
                    onClick={() => check.mutate(remoteUrl.trim())}
                  >
                    {check.isPending ? "Checking…" : "Check"}
                  </Button>
                </div>
                {check.error ? <Verdict tone="error" message={check.error.message} /> : null}
                {verdict ? <Verdict tone={verdict.tone} message={verdict.message} /> : null}
                {verdict && checked?.check.machines.length ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="shrink-0">This machine's name</span>
                    <Input
                      aria-label="Machine name"
                      value={machineName}
                      onChange={(e) => setMachineName(e.currentTarget.value)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </ChoiceButton>
          <ChoiceButton
            selected={choice === "none"}
            onSelect={() => setChoice("none")}
            title="Keep backups on this machine"
            description="Commits stay local, so a lost disk loses them too. You can connect a repo later."
          />
          {create.error ? <Verdict tone="error" message={create.error.message} /> : null}
        </DialogPanel>
        <DialogFooter>
          {startAt === "folder" ? (
            <Button variant="ghost" onClick={() => setStep("folder")}>
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button
            disabled={!canContinue || create.isPending}
            onClick={() => (choice === "create" && !created ? create.mutate(repoName.trim()) : setStep("finish"))}
          >
            {choice === "create" && !created ? (create.isPending ? "Creating…" : "Create repo") : "Next"}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const remote = remoteOf();
  return (
    <>
      <DialogPanel className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Folder</dt>
          <dd className="break-all font-mono">{dir.trim()}</dd>
          <dt className="text-muted-foreground">Pushes to</dt>
          <dd className="break-all font-mono">{remote ?? "Nowhere: local only"}</dd>
          <dt className="text-muted-foreground">Machine</dt>
          <dd className="font-mono">{machineName.trim()}/</dd>
        </dl>
        {created ? <Verdict tone="success" message={`Created ${created.url}.`} /> : null}
        {finish.error ? <Verdict tone="error" message={finish.error.message} /> : null}
        {outcome ? <Verdict tone={outcome.tone} message={outcome.message} /> : null}
      </DialogPanel>
      <DialogFooter>
        {outcome?.ok ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep("github")}>
              Back
            </Button>
            <Button disabled={finish.isPending} onClick={() => finish.mutate()}>
              {finish.isPending ? "Backing up…" : outcome ? "Try again" : "Turn on and back up now"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function ChoiceButton(props: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        props.selected ? "border-ring bg-accent/40" : "border-border",
        props.disabled && "opacity-60",
      )}
    >
      <button
        type="button"
        aria-pressed={props.selected}
        disabled={props.disabled}
        className="flex flex-col items-start gap-0.5 text-left disabled:cursor-not-allowed"
        onClick={props.onSelect}
      >
        <span className="font-medium text-sm">{props.title}</span>
        <span className="text-xs text-muted-foreground">{props.description}</span>
      </button>
      {props.children}
    </div>
  );
}

function Verdict({ tone, message }: { tone: RemoteVerdict["tone"]; message: string }) {
  return (
    <Alert variant={tone}>
      <AlertDescription className="break-words">{message}</AlertDescription>
    </Alert>
  );
}
