import {
  DEFAULT_RUNNER_PORT,
  SERVER_LAUNCHER_NAME,
  suggestMachinePrefix,
  type ConnectMachineInput,
  type MachinesResponse,
} from "@repo/contracts";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useConnectMachine } from "~/state/machines";
import { CommandSnippet } from "../settingsLayout";
import { directRouteFrom, nameFromTarget } from "./machines.logic";

type Via = ConnectMachineInput["via"];

/** A labelled field with an optional line under it. */
function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground/80">
        {label}
      </label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Add a machine: over SSH, where the board installs the runner and pairs with it, or with the pairing code of a
 * runner installed by hand (docs/features/remote-machines.md#connecting-a-machine). `target` prefills the SSH
 * destination, for trying a failed install again.
 */
export function AddMachineDialog({
  data,
  target: initialTarget = "",
  onClose,
}: {
  data: MachinesResponse;
  target?: string;
  onClose: () => void;
}) {
  const connect = useConnectMachine();
  const [via, setVia] = useState<Via>("ssh");
  const [target, setTarget] = useState(initialTarget);
  const [port, setPort] = useState("");
  const [tailscale, setTailscale] = useState(false);
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const tailscaleId = useId();

  const taken = data.machines.map((m) => m.prefix);
  const suggested = suggestMachinePrefix(
    name.trim() || (via === "ssh" ? nameFromTarget(target) : "") || "machine",
    taken,
  );
  const sshPort = port.trim() === "" ? null : Number(port);
  const portOk = sshPort === null || (Number.isInteger(sshPort) && sshPort >= 1 && sshPort <= 65535);
  const route = directRouteFrom(url);
  const ready =
    via === "ssh" ? target.trim() !== "" && portOk && data.releaseAvailable : route !== null && code.trim() !== "";

  const submit = () => {
    if (!ready || connect.isPending) return;
    const identity = {
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
    };
    const input: ConnectMachineInput =
      via === "ssh"
        ? { via: "ssh", target: target.trim(), port: sshPort, tailscale, ...identity }
        : { via: "code", url: route?.kind === "direct" ? route.url : "", code: code.trim(), ...identity };
    // An install carries on in the list, so the dialog's work is done either way.
    connect.mutate(input, { onSuccess: onClose });
  };

  const identity = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Name">
        {(id) => (
          <Input
            id={id}
            size="sm"
            value={name}
            placeholder="The machine's hostname"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Prefix" hint="Suggested from the name. You can change it until a task is numbered with it.">
        {(id) => (
          <Input
            id={id}
            size="sm"
            value={prefix}
            maxLength={3}
            placeholder={suggested}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          />
        )}
      </Field>
    </div>
  );

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a machine</DialogTitle>
          <DialogDescription>
            {via === "ssh"
              ? "The board logs in over SSH, installs the runner as a background service, and pairs with it. Nothing is done by hand on the machine. It needs key login, with no password prompt."
              : "For a machine this one can't SSH to, but can reach over Tailscale."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 text-sm">
          <ToggleGroup
            aria-label="How to connect"
            value={[via]}
            onValueChange={(next) => {
              if (next[0] === "ssh" || next[0] === "code") setVia(next[0]);
            }}
          >
            <Toggle value="ssh">Over SSH</Toggle>
            <Toggle value="code">With a pairing code</Toggle>
          </ToggleGroup>

          {via === "ssh" ? (
            <>
              {data.releaseAvailable ? null : (
                <p className="rounded-lg bg-warning/8 px-3 py-2 text-xs text-warning-foreground dark:bg-warning/16">
                  This board runs from source, which has no release to install on another machine. Connect a runner you
                  installed yourself with a pairing code instead.
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
                <Field label="SSH destination" hint="A host, user@host, or a name from your ~/.ssh/config.">
                  {(id) => (
                    <Input
                      id={id}
                      size="sm"
                      autoFocus
                      value={target}
                      placeholder="alex@engine"
                      spellCheck={false}
                      onChange={(e) => setTarget(e.target.value)}
                    />
                  )}
                </Field>
                <Field label="Port">
                  {(id) => (
                    <Input
                      id={id}
                      size="sm"
                      inputMode="numeric"
                      value={port}
                      placeholder="22"
                      aria-invalid={!portOk}
                      onChange={(e) => setPort(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className="flex items-start gap-2.5">
                <input
                  id={tailscaleId}
                  type="checkbox"
                  className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-primary"
                  checked={tailscale}
                  onChange={(e) => setTailscale(e.currentTarget.checked)}
                />
                <label htmlFor={tailscaleId} className="flex cursor-pointer flex-col">
                  <span>Also reach it at its Tailscale address</span>
                  <span className="text-xs text-muted-foreground">
                    Added as a second route, used when SSH isn't available.
                  </span>
                </label>
              </div>
            </>
          ) : (
            <ol className="flex flex-col gap-4">
              <li className="flex min-w-0 flex-col gap-1.5">
                {data.releaseAvailable ? (
                  <>
                    <span>1. On the machine, run:</span>
                    <CommandSnippet command={data.installCommandTailscale} />
                  </>
                ) : (
                  <>
                    <span>1. On the machine, start a runner of this version and make a code:</span>
                    <CommandSnippet command={`${SERVER_LAUNCHER_NAME} pair`} />
                    <span className="text-xs text-muted-foreground">
                      This board runs from source, so there is no release for an install command to download.
                    </span>
                  </>
                )}
              </li>
              <li className="flex min-w-0 flex-col gap-1.5">
                <span>2. Enter the address and the code it prints:</span>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Address">
                    {(id) => (
                      <Input
                        id={id}
                        size="sm"
                        value={url}
                        placeholder={`http://100.101.102.103:${DEFAULT_RUNNER_PORT}`}
                        spellCheck={false}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Pairing code" hint="Works once, within 10 minutes.">
                    {(id) => (
                      <Input
                        id={id}
                        size="sm"
                        value={code}
                        placeholder="XXXX-XXXX-XXXX"
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(e) => setCode(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
              </li>
            </ol>
          )}

          {identity}

          {connect.error ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground dark:bg-destructive/16"
            >
              {connect.error.message}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || connect.isPending} onClick={submit}>
            {via === "ssh" ? "Install and connect" : connect.isPending ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
