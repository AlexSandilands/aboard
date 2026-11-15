import { taskLabel, type Machine, type Project, type TaskSummary } from "@repo/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  LaptopIcon,
  LockIcon,
  ServerIcon,
  SparklesIcon,
  Undo2Icon,
  WifiOffIcon,
} from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ComposerControl } from "~/components/handoff/T3LaunchPickers";
import { Button } from "~/components/ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useCheckMachine, useMachines } from "~/state/machines";
import { usePullBack, useSetRunOn } from "~/state/mutations";
import { useBoard, useTaskActiveRun } from "~/state/queries";
import {
  canChooseRunOn,
  heldLabel,
  placementOf,
  placementTitle,
  runOnLabel,
  runOnOptions,
  sinceText,
  type Placement,
  type RunOnOption,
} from "./runOn.logic";

// Where a task runs (docs/features/remote-machines.md#choosing-the-machine): the chip in the task panel's header,
// the control in the hand-off window, the card's number and the callout for a machine that can't be reached.

type RunOnTask = Pick<
  TaskSummary,
  "id" | "number" | "numberPrefix" | "projectId" | "kind" | "manual" | "archivedAt" | "status" | "runOn" | "hold"
>;

const NO_MACHINES: Machine[] = [];

/** The machines, the task's project and where the task is, read from the live queries. */
export function useRunOn(task: RunOnTask, projectOverride?: Pick<Project, "workspaceRoot" | "runOn">) {
  const machines = useMachines().data?.machines ?? NO_MACHINES;
  const boardProject = useBoard().data?.projects.find((p) => p.id === task.projectId);
  const project = projectOverride ?? boardProject;
  return {
    machines,
    project,
    placement: placementOf(task, project, machines),
    choosable: canChooseRunOn(task, project, machines),
  };
}

const MACHINE_ICON = { here: LaptopIcon, machine: ServerIcon, project: SparklesIcon } as const;

function OptionIcon({ option, selected }: { option: RunOnOption; selected: boolean }) {
  if (selected) return <CheckIcon className="size-4 text-primary" />;
  const Icon = option.value === null ? MACHINE_ICON.project : option.machine ? MACHINE_ICON.machine : MACHINE_ICON.here;
  return <Icon className="size-4 text-muted-foreground" />;
}

/** The menu's items: one per place the task can run, the current one ticked. */
function RunOnItems({
  options,
  value,
  onPick,
}: {
  options: RunOnOption[];
  value: string | null;
  onPick: (value: string | null) => void;
}) {
  return (
    <MenuGroup>
      <MenuGroupLabel>Run on</MenuGroupLabel>
      {options.map((option) => (
        <MenuItem
          key={option.value ?? "default"}
          disabled={option.disabled && option.value !== value}
          onClick={() => onPick(option.value)}
          className="items-start"
        >
          <OptionIcon option={option} selected={option.value === value} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5">
              {option.label}
              {option.machine ? (
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", option.disabled ? "bg-muted-foreground/50" : "bg-success")}
                />
              ) : null}
            </span>
            <span className="text-xs text-muted-foreground">{option.detail}</span>
          </span>
        </MenuItem>
      ))}
    </MenuGroup>
  );
}

/**
 * The task panel's chip beside Status. Before the task starts it picks where it runs; once a machine holds it, it
 * says so (with the edits waiting, or that the machine can't be reached) and its popover offers Pull back. Nothing
 * on a board with no machine, or for a task that runs here and can't be pointed elsewhere.
 */
export function RunOnChip({ task }: { task: RunOnTask }) {
  const { machines, project, placement, choosable } = useRunOn(task);
  const setRunOn = useSetRunOn(task.id);
  if (placement.state === "held") return <HeldChip task={task} placement={placement} />;
  if (!choosable) return null;
  const Icon = placement.state === "will" ? ServerIcon : LaptopIcon;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label="Where it runs"
            title={placementTitle(placement) ?? "Runs on this machine. Choose a connected machine to start it there."}
            className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-xs text-foreground/80 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0"
          />
        }
      >
        {setRunOn.isPending ? <Spinner size="xs" /> : <Icon className="text-muted-foreground" />}
        {runOnLabel(placement)}
        <ChevronDownIcon aria-hidden className="opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        <RunOnItems
          options={runOnOptions(project, machines)}
          value={task.runOn ?? null}
          onPick={(value) => setRunOn.mutate(value)}
        />
      </MenuPopup>
    </Menu>
  );
}

/** "On engine": the machine holding the task, and the way to take it back. */
function HeldChip({ task, placement }: { task: RunOnTask; placement: Extract<Placement, { state: "held" }> }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"pull" | "force" | null>(null);
  const run = useTaskActiveRun(task.id);
  const pullBack = usePullBack(task.id);
  const tone = placement.offline
    ? "text-muted-foreground"
    : placement.waiting > 0
      ? "border-transparent bg-warning/8 text-warning-foreground dark:bg-warning/16"
      : "text-foreground/80";
  const label = taskLabel(task);
  const go = (force: boolean) =>
    pullBack.mutate(force, {
      onSuccess: () => {
        setOpen(false);
        setConfirm(null);
      },
    });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirm(null);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Where it runs: ${heldLabel(placement)}`}
            title={placementTitle(placement) ?? undefined}
            className={cn(
              "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0",
              tone,
            )}
          />
        }
      >
        {placement.offline ? <WifiOffIcon /> : <LockIcon className="opacity-70" />}
        {heldLabel(placement)}
        <ChevronDownIcon aria-hidden className="opacity-60" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" padding="compact" className="w-80 text-xs leading-relaxed">
        {confirm ? (
          <div className="space-y-2">
            {confirm === "pull" ? (
              <>
                <p className="font-medium text-foreground">Pull {label} back to this machine?</p>
                <p className="text-muted-foreground">
                  {placement.machineName} gives the task back with everything it did, and this machine fetches its
                  branch. Runs, reviews and sessions happen here from then on.
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-foreground">
                  Take {label} back without {placement.machineName}?
                </p>
                <p className="text-muted-foreground">
                  What {placement.machineName}&apos;s agent did since it was last reached, and hasn&apos;t sent, is
                  lost. Commits it pushed are kept. {placement.machineName} drops its copy when it&apos;s next reached.
                </p>
              </>
            )}
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" size="xs" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant={confirm === "force" ? "destructive" : "default"}
                size="xs"
                disabled={pullBack.isPending}
                onClick={() => go(confirm === "force")}
              >
                {pullBack.isPending ? <Spinner size="xs" /> : null}
                {confirm === "force" ? "Take back" : "Pull back"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              Runs on {placement.machineName} since it started · stays there until it&apos;s pulled back
            </p>
            <div className="flex items-start gap-2 rounded-md bg-accent/50 px-2 py-1.5">
              <ServerIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium text-foreground">{placement.machineName}</p>
                <p className="text-muted-foreground">
                  {placement.offline
                    ? capitalize(sinceText(placement.machine?.lastSeenAt ?? null))
                    : placement.waiting > 0
                      ? `${placement.waiting} ${placement.waiting === 1 ? "change" : "changes"} made here waiting for it`
                      : "Connected"}
                </p>
              </div>
            </div>
            <PullBackAction
              disabledReason={
                run
                  ? `Autopilot is running on ${placement.machineName} for this task. Pull it back once that finishes.`
                  : placement.offline
                    ? `${placement.machineName} has to be reached to give the task back with its last changes.`
                    : null
              }
              onClick={() => setConfirm("pull")}
            >
              Pull back to this machine…
            </PullBackAction>
            {placement.offline && !run ? (
              <PullBackAction danger disabledReason={null} onClick={() => setConfirm("force")}>
                Take back without {placement.machineName}…
              </PullBackAction>
            ) : null}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function PullBackAction({
  children,
  disabledReason,
  danger = false,
  onClick,
}: {
  children: ReactNode;
  disabledReason: string | null;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabledReason !== null}
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:hover:bg-transparent"
    >
      <Undo2Icon
        className={cn("mt-0.5 size-4 shrink-0", danger ? "text-destructive-foreground" : "text-muted-foreground")}
      />
      <span className="min-w-0">
        <span
          className={cn(
            "block font-medium",
            disabledReason ? "text-muted-foreground" : danger ? "text-destructive-foreground" : "text-foreground",
          )}
        >
          {children}
        </span>
        {disabledReason ? <span className="block text-muted-foreground">{disabledReason}</span> : null}
      </span>
    </button>
  );
}

/**
 * The hand-off window's control in the strip under the composer, next to Workspace and branch. It saves the choice
 * onto the task, as the panel's chip does.
 */
export function RunOnStripControl({ task }: { task: RunOnTask }) {
  const { machines, project, placement, choosable } = useRunOn(task);
  const setRunOn = useSetRunOn(task.id);
  if (!choosable) return null;
  const Icon = placement.state === "will" ? ServerIcon : LaptopIcon;
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl size="xs" aria-label="Where it runs" />}>
        {setRunOn.isPending ? <Spinner size="xs" /> : <Icon />}
        {placement.state === "will" ? placement.machine.name : "This machine"}
        <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-64">
        <RunOnItems
          options={runOnOptions(project, machines)}
          value={task.runOn ?? null}
          onPick={(value) => setRunOn.mutate(value)}
        />
      </MenuPopup>
    </Menu>
  );
}

/**
 * Why the hand-off window can't start the task here: it is set to run on a machine, and a thread or session started
 * from this window would run on this one. Null when it runs here.
 */
export function runsElsewhereNote(placement: Placement): string | null {
  if (placement.state === "held") {
    return `${placement.machineName} holds this task, and its work happens there. A thread or session from here would work beside it on this machine: pull the task back first.`;
  }
  if (placement.state !== "will") return null;
  const name = placement.machine.name;
  return `This task runs on ${name}. Autopilot's Start planned starts it there once its Autopilot flag is on; a thread or session from here would run on this machine. Choose This machine to start it here.`;
}

/**
 * The card's number, with the machine's letter in front when the task runs on one: dashed before it starts, an amber
 * dot while edits made here wait for the machine, greyed and struck through while the machine can't be reached.
 */
export function MachineNumber({ task, placement }: { task: RunOnTask; placement: Placement }) {
  const number = taskLabel(task);
  if (placement.state === "here") {
    return <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">{number}</span>;
  }
  const machine = placement.state === "will" ? placement.machine : placement.machine;
  const prefix = machine?.prefix ?? (placement.state === "held" ? placement.machineName.slice(0, 1).toUpperCase() : "");
  const offline = placement.state === "held" && placement.offline;
  const waiting = placement.state === "held" && placement.waiting > 0 && !offline;
  return (
    <span
      title={placementTitle(placement) ?? undefined}
      data-machine-number={placement.state}
      className={cn(
        "relative inline-flex h-4.5 shrink-0 items-center gap-0.5 rounded-[5px] px-1 font-mono text-xs tabular-nums",
        placement.state === "will"
          ? "text-muted-foreground shadow-[inset_0_0_0_1px] shadow-violet-500/45"
          : offline
            ? "bg-muted text-muted-foreground"
            : "bg-violet-500/14 text-foreground/80",
      )}
    >
      <b className={cn("font-bold", offline ? "line-through" : "text-violet-700 dark:text-violet-300")}>{prefix}</b>
      {number.slice(1)}
      {waiting ? (
        <span aria-hidden className="absolute -end-1 -top-1 size-1.5 rounded-full bg-warning ring-2 ring-card" />
      ) : null}
      <span className="sr-only">{placementTitle(placement)}</span>
    </span>
  );
}

/** In the task panel while the machine holding the task can't be reached: what that means, and Try now. */
export function MachineOfflineCallout({ placement }: { placement: Placement }) {
  const check = useCheckMachine();
  if (placement.state !== "held" || !placement.offline || !placement.machine) return null;
  const { machineName, machine } = placement;
  return (
    <div
      role="status"
      className="space-y-1.5 rounded-lg bg-muted/60 px-3 py-2 text-xs leading-relaxed text-foreground/85"
    >
      <p>
        <span className="font-medium text-foreground">
          {machineName} {sinceText(machine.lastSeenAt)}.
        </span>{" "}
        Its agent carries on there. What you change here is shown now and lands on {machineName} when it&apos;s back.
      </p>
      <Button variant="outline" size="xs" disabled={check.isPending} onClick={() => check.mutate(machine.id)}>
        {check.isPending ? <Spinner size="xs" /> : null}
        Try now
      </Button>
    </div>
  );
}

/** The steps that edits made here, still waiting for the machine holding the task, change (TaskHold.waitingSteps). */
const WaitingStepsContext = createContext<{ steps: ReadonlySet<string>; machineName: string } | null>(null);

export function WaitingStepsProvider({ task, children }: { task: Pick<TaskSummary, "hold">; children: ReactNode }) {
  const steps = task.hold?.waitingSteps;
  const machineName = task.hold?.machineName ?? "";
  const value = useMemo(
    () => (steps && steps.length > 0 ? { steps: new Set(steps), machineName } : null),
    [steps, machineName],
  );
  return <WaitingStepsContext.Provider value={value}>{children}</WaitingStepsContext.Provider>;
}

/** A clock beside a step whose change made here hasn't reached the machine yet. Nothing otherwise. */
export function StepWaitingMark({ stepId }: { stepId: string }) {
  const waiting = useContext(WaitingStepsContext);
  if (!waiting?.steps.has(stepId)) return null;
  const text = `Changed here, waiting for ${waiting.machineName}: shown already, applied once it can be reached`;
  return (
    <span title={text} className="flex shrink-0 text-warning-foreground">
      <ClockIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** In place of an activity entry's age while the edit that wrote it waits for the machine. */
export function EventWaitingMark({ machineName }: { machineName: string }) {
  return (
    <span
      title={`Waiting for ${machineName}: shown already, applied once it can be reached`}
      className="flex shrink-0 items-center gap-1 text-2xs text-warning-foreground"
    >
      <ClockIcon aria-hidden className="size-3" />
      waiting for {machineName}
    </span>
  );
}
