import { BRAND, type HostedRunnerPairingCode, type UpdateHostedRunnerInput } from "@repo/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { ApiError } from "~/lib/api";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import {
  useConfigureHostedRunner,
  useHostedRunner,
  useHostedRunnerPairingCode,
  useUnpairHostedRunner,
} from "~/state/machines";
import { cn } from "~/lib/utils";
import { CopyButton, SettingsNote, SettingsRow, SettingsSection, StatusDot } from "../settingsLayout";
import { hostedRunnerLine, pairingAddresses, runsWarning } from "./hostedRunner.logic";

/** The code just made, with where to type it on the other board. */
function PairingCode({ code }: { code: HostedRunnerPairingCode }) {
  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">
        On the other board, open Settings › Integrations › Machines › Add machine › By pairing code, and enter an
        address and this code. It works once, until {new Date(code.expiresAt).toLocaleTimeString()}.
      </p>
      <div className="flex items-center gap-1">
        <code className="font-mono text-base font-semibold tracking-wider">{code.code}</code>
        <CopyButton text={code.code} label="Copy code" />
      </div>
      <dl className="flex flex-col gap-1.5">
        {pairingAddresses(code).map((address) => (
          <div key={address.url} className="flex min-w-0 flex-wrap items-center gap-x-2">
            <dt className="text-xs text-muted-foreground">{address.label}</dt>
            <dd className="flex min-w-0 items-center gap-0.5">
              <code className="min-w-0 truncate font-mono text-xs">{address.url}</code>
              <CopyButton text={address.url} label="Copy address" />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Settings › Integrations › Machines › This machine: letting another board run tasks here, in a runner beside this
 * board (docs/features/remote-machines.md#a-board-that-is-also-a-runner).
 */
export function HostedRunnerSection() {
  const status = useHostedRunner();
  const configure = useConfigureHostedRunner();
  const makeCode = useHostedRunnerPairingCode();
  const unpair = useUnpairHostedRunner();
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  // A change that would end runs in flight, waiting for the user to say so, with the question as it was asked: it
  // stays until answered, even if the runs end meanwhile (forcing it then ends nothing).
  const [pending, setPending] = useState<{
    input: UpdateHostedRunnerInput;
    warning: { text: string; action: string };
  } | null>(null);
  const data = status.data;

  if (!data) {
    return (
      <SettingsSection title="This machine">
        <SettingsNote>{status.error ? status.error.message : "Loading..."}</SettingsNote>
      </SettingsSection>
    );
  }
  const line = hostedRunnerLine(data);
  const running = data.state === "running";
  // A code is for the runner as it is now: one made before it was turned off or paired means nothing.
  const code = running && !data.board ? makeCode.data : undefined;
  const change = (input: UpdateHostedRunnerInput) => {
    makeCode.reset();
    const asked = runsWarning(data, input);
    if (asked) {
      setPending({ input, warning: asked });
      return;
    }
    configure.mutate(input, {
      onError: (error) => {
        // A run started since the status was read: ask, as if it had been known.
        if (error instanceof ApiError && error.code === "CONFLICT") {
          const action = input.enabled === false ? "Stop anyway" : "Restart anyway";
          setPending({ input, warning: { text: error.message, action } });
          void status.refetch();
        }
      },
    });
  };
  return (
    <SettingsSection title="This machine">
      <SettingsRow
        id="integrations.machines.runner"
        title="Let other machines run tasks here"
        description={`Another board pairs with this machine and runs its tasks here, beside this board's own. Its tasks never appear on this board. The runner updates with ${BRAND.name}, and its T3 Code threads use this board's T3 Code connection.`}
        status={
          <span className="flex min-w-0 items-baseline gap-2">
            <StatusDot tone={line.tone} label={line.label} className="translate-y-[-1px]" />
            <span className={cn("min-w-0 break-words", line.tone === "danger" && "text-destructive-foreground")}>
              {line.text}
            </span>
          </span>
        }
        control={
          <Switch
            checked={data.enabled}
            disabled={configure.isPending}
            onCheckedChange={(enabled) => change({ enabled })}
            aria-label="Let other machines run tasks here"
          />
        }
      >
        {pending ? (
          <div className="mt-3 flex flex-col gap-2 rounded-lg bg-warning/8 px-3 py-2.5 text-sm dark:bg-warning/16 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:gap-3">
            <p className="min-w-0 flex-1">{pending.warning.text}</p>
            <div className="flex gap-2">
              <Button size="xs" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={configure.isPending}
                onClick={() =>
                  configure.mutate({ ...pending.input, force: true }, { onSettled: () => setPending(null) })
                }
              >
                {pending.warning.action}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      {data.enabled ? (
        <SettingsRow
          id="integrations.machines.runner-tailscale"
          title="Reachable over Tailscale"
          description="Also answer on this machine's network addresses, for a board that reaches it over Tailscale. Off, only this machine can reach it, which is all an SSH tunnel from the other board needs."
          control={
            <Switch
              checked={data.bind === "private"}
              disabled={configure.isPending}
              onCheckedChange={(on) => change({ bind: on ? "private" : "loopback" })}
              aria-label="Reachable over Tailscale"
            />
          }
        />
      ) : null}
      {running && data.board ? (
        <SettingsRow
          id="integrations.machines.runner-pairing"
          title={`Works for ${data.board.name}`}
          description={`Paired ${formatRelativeTimeLabel(data.board.pairedAt)}${
            data.board.lastUsedAt ? `, last heard from ${formatRelativeTimeLabel(data.board.lastUsedAt)}` : ""
          }. A machine works for one board; unpair it to pair another. What it holds stays here until that board takes it back.`}
          control={
            confirmUnpair ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setConfirmUnpair(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={unpair.isPending}
                  onClick={() => unpair.mutate(undefined, { onSettled: () => setConfirmUnpair(false) })}
                >
                  Unpair {data.board.name}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmUnpair(true)}>
                Unpair
              </Button>
            )
          }
        />
      ) : running ? (
        <SettingsRow
          id="integrations.machines.runner-pairing"
          title="Pair a board"
          description="Make a one-time code here and enter it on the board that will run tasks on this machine."
          control={
            <Button size="sm" variant="outline" disabled={makeCode.isPending} onClick={() => makeCode.mutate()}>
              {code ? "New code" : "Make pairing code"}
            </Button>
          }
        >
          {code ? <PairingCode code={code} /> : null}
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
