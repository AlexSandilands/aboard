import {
  BRAND,
  SERVER_LAUNCHER_NAME,
  machineRouteLabel,
  type Machine,
  type MachineInstall,
  type MachineLogin,
  type MachinesResponse,
} from "@repo/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleIcon,
  PlusIcon,
  ServerIcon,
  XIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { cn } from "~/lib/utils";
import {
  useCheckMachine,
  useDismissMachineInstall,
  useMachines,
  useRemoveMachine,
  useRepairMachine,
  useRequestMachineUpdate,
  useUpdateMachine,
} from "~/state/machines";
import { BlurInput } from "../BlurInput";
import { SettingsGroup, SettingsNote, SettingsSectionHeader, StatusDot } from "../settingsLayout";
import { AddMachineDialog } from "./AddMachineDialog";
import {
  LOGIN_WORDS,
  asSentence,
  directRouteFrom,
  loginName,
  machineSummary,
  moveRoute,
  untilLabel,
  versionLine,
  type BadgeTone,
} from "./machines.logic";

const CALLOUT_TONES = {
  error: "bg-destructive/8 dark:bg-destructive/16",
  warning: "bg-warning/8 dark:bg-warning/16",
} as const;

function Callout({ tone, children }: { tone: keyof typeof CALLOUT_TONES; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg px-3 py-2.5 text-sm", CALLOUT_TONES[tone])}>{children}</div>
  );
}

/** One titled part of an open machine. */
function Part({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-3 first:border-t-0 sm:px-4">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

const Hint = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground">{children}</p>;

function ToneBadge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <Badge variant={tone}>{children}</Badge>;
}

/** What stands between the board and the machine, with the one thing to do about it. */
function ConnectionCallout({ machine }: { machine: Machine }) {
  const check = useCheckMachine();
  const repair = useRepairMachine();
  const [code, setCode] = useState("");
  if (machine.connection === "unreachable") {
    return (
      <Callout tone="error">
        <p>
          <strong className="font-semibold">No route to {machine.name} works right now.</strong>{" "}
          {machine.error ? `${asSentence(machine.error)} ` : ""}The board keeps trying; the machine carries on with its
          tasks meanwhile.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={check.isPending} onClick={() => check.mutate(machine.id)}>
            {check.isPending ? "Trying…" : "Try now"}
          </Button>
          {machine.lastSeenAt ? <Hint>Last seen {formatRelativeTimeLabel(machine.lastSeenAt)}</Hint> : null}
        </div>
      </Callout>
    );
  }
  if (machine.connection === "unpaired") {
    const pair = () =>
      code.trim() && repair.mutate({ id: machine.id, code: code.trim() }, { onSuccess: () => setCode("") });
    return (
      <Callout tone="warning">
        <p>
          <strong className="font-semibold">{machine.name} no longer accepts this board.</strong> On the machine, run{" "}
          <code className="font-mono text-xs">{SERVER_LAUNCHER_NAME} pair</code> and enter the code it prints.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="sm"
            className="w-44"
            aria-label="Pairing code"
            placeholder="XXXX-XXXX-XXXX"
            spellCheck={false}
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pair()}
          />
          <Button size="xs" disabled={!code.trim() || repair.isPending} onClick={pair}>
            Pair
          </Button>
        </div>
      </Callout>
    );
  }
  if (machine.connection === "needs-update") {
    return (
      <Callout tone="warning">
        <p>
          <strong className="font-semibold">
            {machine.name} runs {machine.version ?? "a version"}, which this board ({BRAND.version}) can't talk to.
          </strong>{" "}
          Nothing is exchanged with it until it is updated. It carries on with the tasks it holds, and the board catches
          up afterwards.
        </p>
      </Callout>
    );
  }
  return null;
}

function VersionPart({ machine }: { machine: Machine }) {
  const update = useRequestMachineUpdate();
  const line = versionLine(machine, BRAND.version);
  const runs = machine.runsInFlight ?? 0;
  return (
    <Part title="Version">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {line.badge ? <ToneBadge tone={line.badge.tone}>{line.badge.label}</ToneBadge> : null}
        <span className="min-w-0 break-words">{line.text}</span>
      </p>
      {line.action ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: machine.id, now: line.action?.now ?? false })}
          >
            {line.action.label}
          </Button>
          {line.action.hint ? <Hint>{line.action.hint}</Hint> : null}
        </div>
      ) : null}
      {machine.platform ? (
        <Hint>
          {machine.platform}
          {runs > 0 ? ` · ${runs} run${runs === 1 ? "" : "s"} in flight` : ""}
        </Hint>
      ) : null}
    </Part>
  );
}

const LOGIN_BADGES: Record<MachineLogin["state"], { tone: BadgeTone | "outline"; mark: string }> = {
  ok: { tone: "success", mark: "✓" },
  "logged-out": { tone: "warning", mark: "!" },
  missing: { tone: "error", mark: "✕" },
  unknown: { tone: "outline", mark: "?" },
};

function LoginsPart({ machine }: { machine: Machine }) {
  if (machine.connection === "needs-update" || !machine.logins) {
    return (
      <Part title="Logins on the machine">
        <Hint>
          {machine.connection === "needs-update"
            ? "Not read while the machine can't be talked to."
            : "Read once the machine is connected."}
        </Hint>
      </Part>
    );
  }
  return (
    <Part title="Logins on the machine">
      <ul className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
        {machine.logins.map((login) => (
          <li key={login.name} className="flex min-w-0 items-start gap-2">
            <Badge variant={LOGIN_BADGES[login.state].tone} aria-hidden className="w-6 justify-center">
              {LOGIN_BADGES[login.state].mark}
            </Badge>
            <div className="min-w-0">
              <span className="font-mono text-xs">{loginName(login)}</span>{" "}
              <span className="text-xs text-muted-foreground">{LOGIN_WORDS[login.state]}</span>
              {login.detail ? <p className="text-xs break-words text-muted-foreground">{login.detail}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      <Hint>
        Agents on {machine.name} use its own logins. Log in there yourself; the board checks again within a minute.
      </Hint>
    </Part>
  );
}

/** `asOf`: when the list was read, which a failed route's next try is counted from. */
function RoutesPart({ machine, asOf }: { machine: Machine; asOf: number }) {
  const save = useUpdateMachine();
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const route = directRouteFrom(address);
  const setRoutes = (routes: Machine["routes"]) => save.mutate({ id: machine.id, routes });
  const add = () => {
    if (!route) return;
    setRoutes([...machine.routes, route]);
    setAdding(false);
    setAddress("");
  };
  return (
    <Part
      title="Routes"
      action={
        adding ? null : (
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <PlusIcon /> Add route
          </Button>
        )
      }
    >
      <ol className="flex flex-col">
        {machine.routes.map((r, i) => {
          const state = machine.routeStates[i];
          const label = machineRouteLabel(r);
          return (
            <li key={label} className="flex min-w-0 items-center gap-2 py-1">
              <span className="w-4 shrink-0 text-end text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 font-mono text-xs break-all">{label}</span>
                  {state?.status === "active" ? <ToneBadge tone="success">In use</ToneBadge> : null}
                  {state?.status === "standby" ? <Badge variant="outline">Standby</Badge> : null}
                  {state?.status === "connecting" ? <ToneBadge tone="info">Trying</ToneBadge> : null}
                  {state?.status === "failed" ? <ToneBadge tone="error">Failed</ToneBadge> : null}
                </span>
                {state?.status === "failed" ? (
                  <p className="text-xs break-words text-muted-foreground">
                    {state.error ? `${asSentence(state.error)} ` : ""}Next try in {untilLabel(state.retryAt, asOf)}.
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center">
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Move ${label} up`}
                  disabled={i === 0 || save.isPending}
                  onClick={() => setRoutes(moveRoute(machine.routes, i, -1))}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Move ${label} down`}
                  disabled={i === machine.routes.length - 1 || save.isPending}
                  onClick={() => setRoutes(moveRoute(machine.routes, i, 1))}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Remove ${label}`}
                  disabled={machine.routes.length === 1 || save.isPending}
                  onClick={() => setRoutes(machine.routes.filter((_, at) => at !== i))}
                >
                  <XIcon />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      {adding ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              size="sm"
              autoFocus
              className="min-w-0 flex-1 sm:max-w-80"
              aria-label="Route address"
              placeholder="http://100.101.102.103:4318"
              spellCheck={false}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <Button size="xs" disabled={!route} onClick={add}>
              Add
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
          <Hint>The machine's Tailscale address or name with its port, or an https URL.</Hint>
        </div>
      ) : null}
      <Hint>
        Tried in this order. The board falls to the next when one stops working and moves back when it returns.
      </Hint>
    </Part>
  );
}

function IdentityPart({ machine }: { machine: Machine }) {
  const save = useUpdateMachine();
  const remove = useRemoveMachine();
  const [confirming, setConfirming] = useState(false);
  const nameId = useId();
  const prefixId = useId();
  return (
    <Part title="Name and prefix">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={nameId} className="text-xs font-medium text-foreground/80">
            Name
          </label>
          <BlurInput
            id={nameId}
            size="sm"
            value={machine.name}
            onSave={(name) => name.trim() && save.mutate({ id: machine.id, name: name.trim() })}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={prefixId} className="text-xs font-medium text-foreground/80">
            Prefix
          </label>
          <BlurInput
            id={prefixId}
            size="sm"
            maxLength={3}
            disabled={machine.prefixFixed}
            value={machine.prefix}
            onSave={(prefix) => prefix.trim() && save.mutate({ id: machine.id, prefix: prefix.trim() })}
          />
          <Hint>
            {machine.prefixFixed
              ? `Tasks are numbered with it (#${machine.prefix}7), so it can't change any more.`
              : `Numbers tasks made on the machine while the board is away: #${machine.prefix}7.`}
          </Hint>
        </div>
      </div>
      {confirming ? (
        <Callout tone="error">
          <p>
            <strong className="font-semibold">Remove {machine.name}?</strong> The board unpairs from it and forgets it.
            The runner stays installed there; to remove that too, run{" "}
            <code className="font-mono text-xs">{SERVER_LAUNCHER_NAME} service uninstall</code> on the machine.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(machine.id)}
            >
              Remove {machine.name}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </Callout>
      ) : (
        <div>
          <Button size="xs" variant="destructive-outline" onClick={() => setConfirming(true)}>
            Remove machine…
          </Button>
        </div>
      )}
    </Part>
  );
}

function MachineRow({
  machine,
  open,
  asOf,
  onToggle,
}: {
  machine: Machine;
  open: boolean;
  asOf: number;
  onToggle: () => void;
}) {
  const summary = machineSummary(machine);
  return (
    <div data-machine={machine.id}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2.5 text-start outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-4"
      >
        {/* Everything but the chevron wraps, so on a narrow screen the chevron stays on the first line. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <StatusDot tone={summary.tone} label={summary.text} />
          <span className="text-sm font-semibold">{machine.name}</span>
          <span
            title="Prefix"
            className="rounded border border-input px-1 font-mono text-[11px] leading-4 text-foreground/70"
          >
            #{machine.prefix}
          </span>
          <span className="min-w-0 text-xs text-muted-foreground">{summary.text}</span>
          <span className="ms-auto flex flex-wrap items-center justify-end gap-1.5 max-sm:ms-4 max-sm:w-full max-sm:justify-start">
            {summary.badges.map((badge) => (
              <ToneBadge key={badge.label} tone={badge.tone}>
                {badge.label}
              </ToneBadge>
            ))}
            {machine.version ? <Badge variant="outline">{machine.version}</Badge> : null}
          </span>
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open ? (
        <div className="border-t border-border/50 bg-background/40 text-sm">
          {machine.connection === "connected" || machine.connection === "connecting" ? null : (
            <div className="px-3 pt-3 sm:px-4">
              <ConnectionCallout machine={machine} />
            </div>
          )}
          <VersionPart machine={machine} />
          <LoginsPart machine={machine} />
          <RoutesPart machine={machine} asOf={asOf} />
          <IdentityPart machine={machine} />
        </div>
      ) : null}
    </div>
  );
}

const STEP_ICONS = {
  done: <CheckIcon className="size-3.5 text-success" />,
  running: <Spinner className="size-3.5" />,
  failed: <XIcon className="size-3.5 text-destructive-foreground" />,
  pending: <CircleIcon className="size-3.5 text-muted-foreground/40" />,
} as const;

/** An install over SSH, where the machine will appear: its steps, and what failed. */
function InstallRow({ install, onRetry }: { install: MachineInstall; onRetry: () => void }) {
  const dismiss = useDismissMachineInstall();
  const failed = install.status === "failed";
  return (
    <div className="flex flex-col gap-2.5 px-3 py-3 text-sm sm:px-4">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {failed ? (
          <StatusDot tone="danger" label="Install failed" />
        ) : (
          <CircleDashedIcon className="size-3.5 text-info-foreground" />
        )}
        <span className="font-semibold">{install.target}</span>
        <span className="text-xs text-muted-foreground">{failed ? "Install failed" : "Installing the runner…"}</span>
      </div>
      <ol className="flex flex-col gap-1">
        {install.steps.map((step) => (
          <li
            key={step.key}
            className={cn(
              "flex items-center gap-2 text-xs",
              step.status === "pending" && "text-muted-foreground/70",
              step.status === "done" && "text-muted-foreground",
              step.status === "running" && "font-medium text-foreground",
              step.status === "failed" && "font-medium text-destructive-foreground",
            )}
          >
            {STEP_ICONS[step.status]}
            {step.label}
          </li>
        ))}
      </ol>
      {failed ? (
        <Callout tone="error">
          <p className="break-words">{install.error}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={onRetry}>
              Try again
            </Button>
            <Button size="xs" variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate(install.id)}>
              Dismiss
            </Button>
          </div>
        </Callout>
      ) : null}
      {install.log.trim() ? (
        <pre className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-[11px] leading-5 text-foreground/80">
          {install.log.trim()}
        </pre>
      ) : null}
    </div>
  );
}

function MachineList({
  data,
  asOf,
  onAdd,
}: {
  data: MachinesResponse;
  asOf: number;
  onAdd: (target?: string) => void;
}) {
  // What the user opened or closed; a machine they haven't touched opens by itself when it needs something.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  // A finished install is the machine below it.
  const installs = data.installs.filter((install) => install.status !== "done");
  if (data.machines.length === 0 && installs.length === 0) {
    return (
      <SettingsGroup>
        <div className="flex flex-col items-center gap-2 px-4 py-9 text-center">
          <ServerIcon className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-semibold">No machines yet</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Add a server or a second computer to run tasks on. The task stays on this board; its agents run there, and
            keep going when this machine is off.
          </p>
          <Button size="sm" className="mt-1" onClick={() => onAdd()}>
            <PlusIcon /> Add machine
          </Button>
        </div>
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup>
      {installs.map((install) => (
        <InstallRow key={install.id} install={install} onRetry={() => onAdd(install.target)} />
      ))}
      {data.machines.map((machine) => {
        const open = toggled[machine.id] ?? machineSummary(machine).attention;
        return (
          <MachineRow
            key={machine.id}
            machine={machine}
            open={open}
            asOf={asOf}
            onToggle={() => setToggled((prev) => ({ ...prev, [machine.id]: !open }))}
          />
        );
      })}
    </SettingsGroup>
  );
}

/**
 * Settings › Integrations › Machines: the other computers this board runs tasks on
 * (docs/features/remote-machines.md#the-machines-page). One row per machine that opens to its version, logins,
 * routes and name; a machine that needs something opens by itself.
 */
export function MachinesSection() {
  const machines = useMachines();
  // `null`: closed. A string prefills the SSH destination, for trying a failed install again.
  const [adding, setAdding] = useState<string | null>(null);
  const data = machines.data;
  const empty = data ? data.machines.length === 0 && data.installs.every((i) => i.status === "done") : true;
  return (
    <section id="integrations.machines.list" className="scroll-mt-4 space-y-2.5">
      <SettingsSectionHeader
        title="Machines"
        headerAction={
          data && !empty ? (
            <Button size="xs" variant="outline" onClick={() => setAdding("")}>
              <PlusIcon /> Add machine
            </Button>
          ) : null
        }
      />
      {data ? (
        <MachineList data={data} asOf={machines.dataUpdatedAt} onAdd={(target) => setAdding(target ?? "")} />
      ) : (
        <SettingsGroup>
          <SettingsNote>{machines.error ? machines.error.message : "Loading machines..."}</SettingsNote>
        </SettingsGroup>
      )}
      {data && adding !== null ? (
        <AddMachineDialog key={adding} data={data} target={adding} onClose={() => setAdding(null)} />
      ) : null}
    </section>
  );
}
