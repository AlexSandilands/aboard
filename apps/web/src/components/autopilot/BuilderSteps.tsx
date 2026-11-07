import {
  CUSTOM_COMMAND_MAX,
  CUSTOM_MINUTES_MAX,
  CUSTOM_MINUTES_MIN,
  CUSTOM_NAME_MAX,
  CUSTOM_PROMPT_MAX,
  CustomAction,
  customAutomationKey,
  describeCustomTrigger,
  INHERIT,
  inputEnvName,
  type AutomationVariable,
  type AutopilotAutomation,
  type ModelChoice,
  type OperationNeed,
  type Project,
  type TaskSummary,
} from "@repo/contracts";
import {
  BotIcon,
  CalendarClockIcon,
  ChevronRightIcon,
  Columns3Icon,
  FileCode2Icon,
  GitPullRequestIcon,
  HourglassIcon,
  LockOpenIcon,
  type LucideIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { inheritDetail } from "~/components/models/choicePicker.logic";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import { WEEKDAYS } from "~/components/recurring/recurring.logic";
import { SettingsGroup, SettingsRow } from "~/components/settings/settingsLayout";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { useSettings } from "~/state/queries";
import {
  BUILDER_STEPS,
  formProjects,
  hasMoreOptions,
  moreOptionsSummary,
  rightNow,
  timeInColumn,
  type BuilderStep,
} from "./builder.logic";
import {
  customFormToInput,
  emptyFormSlots,
  formAgentNeeds,
  formSampleTask,
  parseAllowedTools,
  previewAction,
  PR_EVENTS,
  sampleTask,
  STATUSES,
  triggerOf,
  withActionKind,
  withCheck,
  type CustomForm,
} from "./customAutomations.logic";
import { Choice, Field } from "./FormFields";
import { BlockedWarning, InputsField, SlotsField } from "./InputsAndSlots";
import { InsertChips, insertIntoTextarea } from "./InsertChips";
import { insertChips, knownVariables } from "./insertChips.logic";
import { RunHistoryLink } from "./RunHistoryLink";
import { ScriptField, ScriptTest } from "./ScriptField";
import { RunsAsYouBadge, ScriptWarning } from "./ScriptWarning";
import { SdkStatusBar } from "./SdkStatusBar";
import { VariableNeedsList } from "./VariablesEditor";
import { DraftProjects, WhereProjects } from "./WhereItRuns";
import { variableNeeds } from "./variables.logic";

/** The shell a command runs in here, for the examples: PowerShell on Windows, sh elsewhere. */
const COMMAND_SHELL = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "powershell" : "sh";

const INPUTS_FOR_CODE_HINT = `Values it reads as ${inputEnvName("<name>")} (or inputs on stdin, for a script), declared so whoever imports a shared file fills them in without editing the code.`;

/** What every step reads: the form, how to change it, and the board it is built against. */
export interface StepProps {
  form: CustomForm;
  patch: (next: Partial<CustomForm>) => void;
  setForm: (update: (current: CustomForm) => CustomForm) => void;
  projects: readonly Project[];
  epics: readonly TaskSummary[];
  tasks: readonly TaskSummary[];
  boardVariables: readonly AutomationVariable[];
  /** The saved automation being edited, whose Where step writes its switches; absent for a new one. */
  automation?: AutopilotAutomation | null;
}

/** The step's title and, under it, its body as one settings card. */
export function StepCard({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <h2 className="text-base font-medium">{title}</h2>
        {aside}
      </div>
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

export function Block({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("space-y-4 px-3 py-4 sm:px-4", className)}>{children}</div>;
}

/** The five steps as a row of numbered buttons; one reached already can be gone back (or forward) to. */
export function Stepper({
  step,
  reached,
  onStep,
}: {
  step: BuilderStep;
  /** The furthest step reached: every step up to it can be clicked. */
  reached: BuilderStep;
  onStep: (step: BuilderStep) => void;
}) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-1.5 gap-y-2 px-1">
      {BUILDER_STEPS.map((label, index) => {
        const i = index as BuilderStep;
        const current = i === step;
        const done = i < step || (i <= reached && !current);
        return (
          <li key={label} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={i > reached}
              aria-current={current ? "step" : undefined}
              onClick={() => onStep(i)}
              className={cn(
                "flex items-center gap-1.5 rounded-md py-0.5 pe-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                current
                  ? "font-medium text-foreground"
                  : done
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/60",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "grid size-5.5 shrink-0 place-items-center rounded-full border text-2xs",
                  current
                    ? "border-primary bg-primary text-primary-foreground"
                    : done
                      ? "border-success/50 bg-success/12 text-success-foreground"
                      : "border-input",
                )}
              >
                {done && !current ? "✓" : i + 1}
              </span>
              {label}
            </button>
            {i < BUILDER_STEPS.length - 1 ? <span aria-hidden className="h-px w-4 bg-input" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** A big choice card, like the Appearance page's theme choice. */
function ChoiceCards<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T;
  items: ReadonlyArray<{ value: T; title: string; description: string; icon: LucideIcon; tint: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))]">
      {items.map((item) => {
        const picked = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={picked}
            onClick={() => onChange(item.value)}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              picked
                ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                : "border-border/60 hover:border-border hover:bg-accent/40",
            )}
          >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", item.tint)}>
              <Icon aria-hidden className="size-4" />
            </span>
            <span className="min-w-0 space-y-0.5">
              <span className={cn("block text-sm", picked ? "font-medium text-foreground" : "text-foreground/85")}>
                {item.title}
              </span>
              <span className="block text-xs text-muted-foreground">{item.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

const TRIGGERS: ReadonlyArray<{
  value: CustomForm["triggerKind"];
  title: string;
  description: string;
  icon: LucideIcon;
  tint: string;
}> = [
  {
    value: "status_change",
    title: "A task changes column",
    description: "Into Review, from any column…",
    icon: Columns3Icon,
    tint: "bg-primary/12 text-primary",
  },
  {
    value: "pr_event",
    title: "Something happens on a PR",
    description: "Checks fail, a conflict, new commits, merged…",
    icon: GitPullRequestIcon,
    tint: "bg-info/12 text-info-foreground",
  },
  {
    value: "stale",
    title: "A task sits too long",
    description: "In a column for a number of hours",
    icon: HourglassIcon,
    tint: "bg-warning/12 text-warning-foreground",
  },
  {
    value: "blocker_finished",
    title: "A task's last blocker finishes",
    description: "Every task blocking it is Done",
    icon: LockOpenIcon,
    tint: "bg-success/12 text-success-foreground",
  },
  {
    value: "schedule",
    title: "On a schedule",
    description: "Weekdays at 09:00, or every few minutes or hours",
    icon: CalendarClockIcon,
    tint: "bg-muted text-foreground/80",
  },
];

const ACTIONS: ReadonlyArray<{
  value: CustomForm["actionKind"];
  title: string;
  description: string;
  icon: LucideIcon;
  tint: string;
}> = [
  {
    value: "agent",
    title: "Ask an agent",
    description: "A prompt, run by a coding agent.",
    icon: BotIcon,
    tint: "bg-primary/12 text-primary",
  },
  {
    value: "shell",
    title: "Run a command",
    description: "One line in the project's folder.",
    icon: SquareTerminalIcon,
    tint: "bg-warning/12 text-warning-foreground",
  },
  {
    value: "script",
    title: "Run a script",
    description: "Node.js, Python, PowerShell or sh.",
    icon: FileCode2Icon,
    tint: "bg-info/12 text-info-foreground",
  },
];

/** Step 1: what starts it, and only that trigger's own fields. */
export function WhenStep({ form, patch }: StepProps) {
  return (
    <StepCard title="When should it run?">
      <Block>
        <ChoiceCards
          label="Trigger"
          value={form.triggerKind}
          items={TRIGGERS}
          onChange={(triggerKind) => patch({ triggerKind })}
        />
      </Block>
      {form.triggerKind === "blocker_finished" ? (
        <Block>
          <p className="text-xs text-muted-foreground">
            It fires once for a task, when the last of the tasks blocking it reaches Done.
          </p>
        </Block>
      ) : (
        <Block>
          <TriggerFields form={form} patch={patch} />
        </Block>
      )}
    </StepCard>
  );
}

function TriggerFields({ form, patch }: Pick<StepProps, "form" | "patch">) {
  switch (form.triggerKind) {
    case "status_change":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Into">
            <Choice label="Into column" value={form.to} items={STATUSES} onChange={(to) => to && patch({ to })} />
          </Field>
          <Field label="From">
            <Choice
              label="From column"
              value={form.from}
              items={[{ value: "", label: "Any column" }, ...STATUSES]}
              onChange={(from) => patch({ from })}
            />
          </Field>
        </div>
      );
    case "pr_event":
      return (
        <Field label="When a pull request linked to the task">
          <Choice
            label="Pull request event"
            value={form.prEvent}
            items={PR_EVENTS}
            onChange={(prEvent) => prEvent && patch({ prEvent })}
          />
        </Field>
      );
    case "stale":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="In">
            <Choice
              label="Column"
              value={form.staleStatus}
              items={STATUSES}
              onChange={(staleStatus) => staleStatus && patch({ staleStatus })}
            />
          </Field>
          <Field label="For (hours)" hint="Once per stay in the column.">
            <Input
              size="sm"
              type="number"
              min={1}
              aria-label="Hours in the column"
              value={form.staleHours}
              onChange={(event) => patch({ staleHours: event.currentTarget.value })}
            />
          </Field>
        </div>
      );
    case "schedule":
      return (
        <>
          <Field label="Repeats" hint="Local time, once per project it's on in.">
            <ToggleGroup
              aria-label="Repeat"
              value={[form.scheduleKind]}
              onValueChange={(next) => {
                const scheduleKind = next[0];
                if (scheduleKind === "weekly" || scheduleKind === "interval") patch({ scheduleKind });
              }}
            >
              <Toggle value="weekly">On weekdays</Toggle>
              <Toggle value="interval">Every…</Toggle>
            </ToggleGroup>
          </Field>
          {form.scheduleKind === "weekly" ? (
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field label="Days">
                <ToggleGroup
                  multiple
                  aria-label="Weekdays"
                  className="flex-wrap"
                  value={form.days.map(String)}
                  onValueChange={(next) => patch({ days: next.map(Number) })}
                >
                  {WEEKDAYS.map((day) => (
                    <Toggle key={day.value} value={String(day.value)} aria-label={day.long}>
                      {day.short}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </Field>
              <Field label="At">
                <Input
                  size="sm"
                  type="time"
                  aria-label="Time of day"
                  className="sm:w-32"
                  value={form.time}
                  onChange={(event) => patch({ time: event.currentTarget.value })}
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-[auto_auto_1fr]">
              <Field label="Every">
                <Input
                  size="sm"
                  type="number"
                  min={form.unit === "minutes" ? CUSTOM_MINUTES_MIN : 1}
                  max={form.unit === "minutes" ? CUSTOM_MINUTES_MAX : 24}
                  aria-label="Interval length"
                  className="sm:w-32"
                  value={form.every}
                  onChange={(event) => patch({ every: event.currentTarget.value })}
                />
              </Field>
              <Field label="Unit">
                <ToggleGroup
                  aria-label="Interval unit"
                  value={[form.unit]}
                  onValueChange={(next) => {
                    const unit = next[0];
                    if (unit === "minutes" || unit === "hours") patch({ unit });
                  }}
                >
                  <Toggle value="minutes">Minutes</Toggle>
                  <Toggle value="hours">Hours</Toggle>
                </ToggleGroup>
              </Field>
              <p className="self-end pb-2 text-xs text-muted-foreground">
                {form.unit === "minutes"
                  ? `${CUSTOM_MINUTES_MIN} to ${CUSTOM_MINUTES_MAX} minutes, counted from midnight: 15 runs at 00:00, 00:15, 00:30 and so on.`
                  : "1 to 24 hours, counted from midnight: 6 runs at 00:00, 06:00, 12:00 and 18:00."}
              </p>
            </div>
          )}
        </>
      );
    case "blocker_finished":
      return null;
  }
}

/** Step 2: what it does, as three cards. Its fields are the next step's. */
export function DoStep({ form, setForm }: StepProps) {
  return (
    <StepCard title="What should it do?">
      <Block>
        <ChoiceCards
          label="Action"
          value={form.actionKind}
          items={ACTIONS}
          onChange={(actionKind) => setForm((current) => withActionKind(current, actionKind))}
        />
        {form.triggerKind === "schedule" && form.actionKind === "agent" ? (
          <p className="text-xs text-muted-foreground">
            A scheduled agent can run a check script first, so it starts only when there is something to do. It is under
            More options on the next step.
          </p>
        ) : null}
      </Block>
    </StepCard>
  );
}

/** A closed section of the Details step for what most automations don't need. */
function MoreOptions({ form, children }: { form: CustomForm; children: ReactNode }) {
  // Open when something in it is already set (an edit, an import), so nothing the automation does is hidden.
  const [open, setOpen] = useState(() => hasMoreOptions(form));
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/50">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-3 text-left outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring sm:px-4">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span className="text-sm text-foreground">More options</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{moreOptionsSummary(form)}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel className="border-t border-border/50 [&>div>*+*]:border-t [&>div>*+*]:border-border/50">
        <div>{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** An on/off option, as a settings row with the switch on its right. */
function SwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      title={title}
      description={description}
      control={<Switch aria-label={title} checked={checked} onCheckedChange={onCheckedChange} />}
    />
  );
}

/** Step 3: the prompt, command or script up front; the rest under More options. */
export function DetailsStep(props: StepProps) {
  const { form } = props;
  const title =
    form.actionKind === "agent"
      ? "What should the agent do?"
      : form.actionKind === "shell"
        ? "Which command?"
        : "The script";
  return (
    <StepCard
      title={title}
      aside={
        form.actionKind === "agent" ? null : (
          <RunsAsYouBadge kind={form.actionKind === "shell" ? "command" : "script"} />
        )
      }
    >
      {form.actionKind === "agent" ? (
        <AgentDetails {...props} />
      ) : form.actionKind === "script" ? (
        <ScriptDetails {...props} />
      ) : (
        <CommandDetails {...props} />
      )}
    </StepCard>
  );
}

function AgentDetails({ form, patch, setForm, projects, boardVariables }: StepProps) {
  const isSchedule = form.triggerKind === "schedule";
  const checking = isSchedule && form.checkOn;
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const variables = knownVariables(boardVariables, projects);
  const empty = emptyFormSlots(form);
  return (
    <>
      <Block>
        <Field
          label="Prompt"
          hint={
            isSchedule
              ? "Placeholders are filled in when it runs. The project's name and folder are added after it."
              : "Placeholders are filled in when it runs. The task's details are added after it."
          }
        >
          <InsertChips
            chips={insertChips({
              target: "prompt",
              inputs: form.inputs.map((i) => i.name),
              variables,
              hasTask: !isSchedule,
              checking,
            })}
            onInsert={(text) => insertIntoTextarea(promptBox.current, text, (prompt) => patch({ prompt }))}
          />
          <Textarea
            ref={promptBox}
            autoFocus
            aria-label="Prompt"
            maxLength={CUSTOM_PROMPT_MAX}
            value={form.prompt}
            placeholder={
              isSchedule
                ? "Look through this project's open pull requests and list the ones waiting on a review."
                : "The checks on {{pr.url}} are failing. Find out why and push a fix."
            }
            onChange={(event) => patch({ prompt: event.currentTarget.value })}
          />
        </Field>
        {isSchedule ? (
          <p className="text-xs text-muted-foreground">
            A scheduled agent has no task: it runs headless in an empty temporary folder, not the project&apos;s own,
            and can use the board&apos;s tools to find its work. Each run ends with a short handover that the next run
            in the same project is given.
          </p>
        ) : null}
      </Block>
      <MoreOptions form={form}>
        <Block>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" hint="Inherit takes the board's model for custom automations.">
              <ActionModelPicker
                value={form.model}
                isSchedule={isSchedule}
                needs={formAgentNeeds(form)}
                onChange={(model) => patch({ model })}
              />
            </Field>
            <Field label="Skill" hint="The agent is told to use it.">
              <Input
                size="sm"
                aria-label="Skill"
                value={form.skill}
                placeholder="fix-ci"
                onChange={(event) => patch({ skill: event.currentTarget.value })}
              />
            </Field>
          </div>
        </Block>
        {isSchedule ? (
          <>
            <SwitchRow
              title="Check first with a script"
              description="Runs before any agent. Each JSON line it prints is an item, and each item it hasn't printed before starts an agent of its own; printing nothing starts nothing. In Preview the check still runs for real."
              checked={form.checkOn}
              onCheckedChange={(checkOn) => setForm((current) => withCheck(current, checkOn))}
            />
            {form.checkOn ? (
              <>
                <Block>
                  <ScriptWarning />
                  <ScriptField
                    kind="check"
                    form={form}
                    patch={patch}
                    projects={projects}
                    sample={null}
                    withTest={false}
                  />
                </Block>
                <SwitchRow
                  title="Treat the items as untrusted"
                  description="Items often carry text anyone can write, such as a pull request title or comment. On, each item's agent runs read-only with only this board's tools. It can't be combined with allowed tools or tool slots."
                  checked={form.untrustedItems}
                  onCheckedChange={(untrustedItems) => patch({ untrustedItems })}
                />
                {form.untrustedItems ? null : (
                  <Block>
                    <Alert variant="warning">
                      <AlertDescription>
                        Each item&apos;s agent gets the same access as any scheduled agent here, including writing, and
                        it reads text the check copied from outside. Only turn this off when whoever can write that text
                        is trusted.
                      </AlertDescription>
                    </Alert>
                  </Block>
                )}
              </>
            ) : null}
          </>
        ) : (
          <SwitchRow
            title="Work on the pull request's branch"
            description="When the task has an open pull request, the agent pushes to it instead of starting a new branch."
            checked={form.onPrBranch}
            onCheckedChange={(onPrBranch) => patch({ onPrBranch })}
          />
        )}
        <Block>
          <Field
            label="Allowed tools"
            hint={
              <>
                One per line. A whole MCP server (<code className="font-mono">mcp__issue-tracker</code>) or one of its
                tools (<code className="font-mono">mcp__issue-tracker__search_jira</code>). The board&apos;s own tools
                are always allowed.
              </>
            }
          >
            <Textarea
              aria-label="Allowed tools"
              className="font-mono"
              rows={3}
              value={form.allowedTools}
              placeholder={"mcp__issue-tracker\nmcp__issue-tracker__search_jira"}
              onChange={(event) => patch({ allowedTools: event.currentTarget.value })}
            />
          </Field>
          {parseAllowedTools(form.allowedTools).length > 0 ? (
            <Alert variant="warning">
              <AlertDescription>
                These tools run unattended: nobody is asked to approve a call, so the agent can use everything they
                offer, including anything that writes. Allow a single tool rather than a whole server when you can. The
                server must be one of your own (<code className="font-mono">claude mcp add --scope user</code>, a plugin
                or a connector): a server from a project&apos;s <code className="font-mono">.mcp.json</code> needs an
                approval nobody can give in an unattended run. An agent with extra tools runs headless, not in a T3 Code
                thread.
              </AlertDescription>
            </Alert>
          ) : null}
        </Block>
        <Block>
          <Field
            label="Inputs"
            hint="Values the prompt reads as {{inputs.name}}. A shared file asks whoever imports it to fill them in, so they never edit the prompt."
          >
            <InputsField inputs={form.inputs} onChange={(inputs) => patch({ inputs })} />
          </Field>
          <Field
            label="Required tools"
            hint="Tools it needs but can't name, since people use different MCP servers: Jira search, say. The prompt is told which tools fill each slot. Sharing it leaves the tools out."
          >
            <SlotsField slots={form.slots} onChange={(slots) => patch({ slots })} />
          </Field>
          {empty.length > 0 ? (
            <BlockedWarning
              reason={`Won't work until you fill in: ${empty.map((slot) => slot.label || slot.name || "a tool slot").join(", ")}`}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">
            The runner, budget and timeout are this automation&apos;s settings in the Autopilot list, per scope.
          </p>
        </Block>
      </MoreOptions>
    </>
  );
}

function ScriptDetails({ form, patch, projects, tasks }: StepProps) {
  return (
    <>
      <Block>
        <ScriptField
          kind="action"
          form={form}
          patch={patch}
          projects={projects}
          sample={formSampleTask(form, tasks)}
          withTest={false}
        />
      </Block>
      <MoreOptions form={form}>
        <Block>
          <Field label="Inputs" hint={INPUTS_FOR_CODE_HINT}>
            <InputsField inputs={form.inputs} onChange={(inputs) => patch({ inputs })} />
          </Field>
        </Block>
      </MoreOptions>
    </>
  );
}

function CommandDetails({ form, patch, projects, boardVariables }: StepProps) {
  const commandBox = useRef<HTMLTextAreaElement>(null);
  const variables = knownVariables(boardVariables, projects);
  return (
    <>
      <Block>
        <Field
          label="Command"
          hint={
            <>
              Runs in the project&apos;s folder, in sh (PowerShell on Windows). It is never filled in: read values from
              the environment, as <code className="font-mono">&quot;$NAME&quot;</code> in sh or{" "}
              <code className="font-mono">$env:NAME</code> in PowerShell.
            </>
          }
        >
          <InsertChips
            chips={insertChips({
              target: COMMAND_SHELL,
              inputs: form.inputs.map((i) => i.name),
              variables,
              hasTask: form.triggerKind !== "schedule",
            })}
            onInsert={(text) => insertIntoTextarea(commandBox.current, text, (command) => patch({ command }))}
          />
          <Textarea
            ref={commandBox}
            autoFocus
            aria-label="Command"
            className="font-mono"
            maxLength={CUSTOM_COMMAND_MAX}
            value={form.command}
            placeholder="./scripts/notify.sh"
            onChange={(event) => patch({ command: event.currentTarget.value })}
          />
          <SdkStatusBar
            language={COMMAND_SHELL}
            scriptRole="action"
            onInsert={(text) => insertIntoTextarea(commandBox.current, text, (command) => patch({ command }))}
          />
        </Field>
        <Field label="Timeout (seconds)" hint="It is stopped after this long, and the run fails.">
          <Input
            size="sm"
            type="number"
            min={1}
            max={3600}
            aria-label="Timeout in seconds"
            className="sm:w-32"
            value={form.timeoutSeconds}
            onChange={(event) => patch({ timeoutSeconds: event.currentTarget.value })}
          />
        </Field>
      </Block>
      <MoreOptions form={form}>
        <Block>
          <Field label="Inputs" hint={INPUTS_FOR_CODE_HINT}>
            <InputsField inputs={form.inputs} onChange={(inputs) => patch({ inputs })} />
          </Field>
        </Block>
      </MoreOptions>
    </>
  );
}

/**
 * Step 4: where it runs, as the automation's page's Where it runs (a saved one's switches change as they are picked, a
 * new one's are written when it is saved), and for a task trigger which tasks.
 */
export function WhereStep({ form, patch, projects, automation }: StepProps) {
  const lanes = [...projects]
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map((p) => ({ id: p.id, title: p.title }));
  return (
    <StepCard title="Where?">
      <Block>
        <Field label="Projects">
          <div className="flex flex-col gap-2">
            {automation ? (
              <WhereProjects automation={automation} />
            ) : (
              <DraftProjects
                projects={lanes}
                everywhere={form.everywhere}
                projectIds={form.projectIds}
                onChange={(next) => patch(next)}
              />
            )}
          </div>
        </Field>
        {form.triggerKind === "schedule" ? null : (
          <Field label="With any of these labels" hint="Comma-separated; blank is any task.">
            <Input
              size="sm"
              aria-label="Labels"
              value={form.labels}
              placeholder="ui, backend"
              onChange={(event) => patch({ labels: event.currentTarget.value })}
            />
          </Field>
        )}
      </Block>
      {form.triggerKind === "schedule" ? null : (
        <SettingsRow
          title="Tasks in epics"
          info="This sets the default. An epic's popover on the board can still switch it on or off for that epic."
          description={`${form.epicTasks ? "Runs on tasks in epics too." : "Skips tasks in epics."} One epic is switched from its popover.`}
          control={
            <Switch
              aria-label="Run on tasks in epics"
              checked={form.epicTasks}
              onCheckedChange={(epicTasks) => patch({ epicTasks })}
            />
          }
        />
      )}
    </StepCard>
  );
}

/** The one line the Review step shows for each earlier step, with an Edit that goes back to it. */
function sectionSummaries(form: CustomForm, projects: readonly Project[]) {
  const parsed = triggerOf(form);
  const trigger = typeof parsed === "string" ? parsed : describeCustomTrigger(parsed);
  const action = ACTIONS.find((a) => a.value === form.actionKind)!.title;
  const details =
    form.actionKind === "agent"
      ? [
          form.prompt.trim() ? `${form.prompt.trim().split("\n").length}-line prompt` : "No prompt yet",
          form.triggerKind === "schedule" && form.checkOn ? `${form.checkLanguage} check script` : null,
          form.skill.trim() ? `skill ${form.skill.trim()}` : null,
          parseAllowedTools(form.allowedTools).length > 0
            ? `${parseAllowedTools(form.allowedTools).length} allowed tools`
            : null,
          form.inputs.length > 0 ? `${form.inputs.length} inputs` : null,
        ]
      : form.actionKind === "shell"
        ? [form.command.trim() || "No command yet", form.inputs.length > 0 ? `${form.inputs.length} inputs` : null]
        : [
            `${form.body.split("\n").length}-line ${form.language} script`,
            form.inputs.length > 0 ? `${form.inputs.length} inputs` : null,
          ];
  const named = formProjects(form, projects).map((p) => p.title);
  const where = [
    form.everywhere ? "Every project" : named.length > 0 ? named.join(", ") : "No project yet",
    form.triggerKind !== "schedule" && form.labels.trim() ? `labels ${form.labels.trim()}` : null,
    form.triggerKind !== "schedule" && !form.epicTasks ? "skips tasks in epics" : null,
  ];
  const join = (parts: readonly (string | null)[]) => parts.filter(Boolean).join(" · ");
  return [
    { step: 0 as BuilderStep, title: "When", text: trigger },
    { step: 1 as BuilderStep, title: "Do", text: action },
    { step: 2 as BuilderStep, title: "Details", text: join(details) },
    { step: 3 as BuilderStep, title: "Where", text: join(where) },
  ];
}

/**
 * Step 5: the sentence, each section with an Edit, what it would run for right now, a try, and the name. Saving is
 * the footer's.
 */
export function ReviewStep({
  sentence,
  customId,
  isNew,
  onStep,
  ...props
}: StepProps & {
  sentence: string;
  customId: string | null;
  isNew: boolean;
  onStep: (step: BuilderStep) => void;
}) {
  const { form, patch, projects, tasks, boardVariables } = props;
  const isSchedule = form.triggerKind === "schedule";
  const [now] = useState(() => new Date());
  const result = customFormToInput({ ...form, name: form.name || "x" });
  const sample = result.ok && !isSchedule ? sampleTask(result.input, tasks) : null;
  const preview = result.ok ? previewAction(result.input, sample, projects, boardVariables) : null;
  const needs = result.ok
    ? variableNeeds(CustomAction.parse(result.input.action), boardVariables, formProjects(form, projects))
    : [];
  const due = rightNow(form, tasks, projects, now);
  const trigger = triggerOf(form);
  const [showPrompt, setShowPrompt] = useState(false);
  const checking = isSchedule && form.actionKind === "agent" && form.checkOn;

  return (
    <div className="space-y-6">
      <StepCard title="Review & try">
        <Block>
          <p className="text-sm leading-relaxed text-foreground">{sentence}</p>
        </Block>
        {sectionSummaries(form, projects).map((section) => (
          // Its own row rather than a SettingsRow, so Edit stays beside the line on a phone instead of under it.
          <div key={section.title} className="flex items-center gap-3 px-3 py-3 sm:px-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">{section.title}</div>
              <div className="text-xs break-words text-muted-foreground">{section.text}</div>
            </div>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={`Edit ${section.title}`}
              onClick={() => onStep(section.step)}
            >
              Edit
            </Button>
          </div>
        ))}
      </StepCard>

      <StepCard title={isSchedule ? "When it would run" : "Right now this would run for"}>
        <Block>
          {due.kind === "schedule" ? (
            <p className="text-sm">
              {typeof trigger === "string" ? "On its schedule" : describeCustomTrigger(trigger)}, once in each of{" "}
              {due.projects.length > 0 ? due.projects.join(", ") : "no project yet"} where it is switched on.
            </p>
          ) : due.kind === "tasks" ? (
            due.tasks.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {due.tasks.map((t) => (
                  <li key={t.id} className="flex min-w-0 gap-1.5">
                    <span className="shrink-0 text-muted-foreground">#{t.number}</span>
                    <span className="min-w-0 truncate">{t.title}</span>
                    <span className="shrink-0 text-muted-foreground">
                      · {projects.find((p) => p.id === t.projectId)?.title} · {timeInColumn(t, now)}
                    </span>
                  </li>
                ))}
                {due.more > 0 ? <li className="text-xs text-muted-foreground">and {due.more} more</li> : null}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No task has been there that long yet.</p>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing yet. It acts on what happens after it&apos;s switched on.
              {sample ? ` The newest task it could act on is #${sample.number} ${sample.title}.` : ""}
            </p>
          )}
          {due.kind === "tasks" && due.tasks.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Each of these would get a run once it is switched on, in Preview a recorded one.
            </p>
          ) : null}
        </Block>
      </StepCard>

      <StepCard title="Try it">
        {form.actionKind === "agent" ? (
          <Block>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {checking
                  ? "The prompt an item's agent would start with. Nothing is started."
                  : sample
                    ? `The prompt it would send for #${sample.number}. Nothing is started.`
                    : isSchedule
                      ? "The prompt it would send in the first project. Nothing is started."
                      : "No task on the board fits it yet, so there is no prompt to show."}
              </span>
              <Button size="xs" variant="outline" onClick={() => setShowPrompt((s) => !s)}>
                {showPrompt ? "Hide the prompt" : "Show the prompt"}
              </Button>
            </div>
            {showPrompt ? (
              <PreviewBlock>{preview ?? (result.ok ? "Nothing to preview." : result.error)}</PreviewBlock>
            ) : null}
          </Block>
        ) : form.actionKind === "shell" ? (
          <Block>
            <span className="text-xs text-muted-foreground">
              What it would run{sample ? ` for #${sample.number}` : ""}. A command can&apos;t be run from here: try it
              in a terminal first.
            </span>
            <PreviewBlock>{preview ?? (result.ok ? "Nothing to preview." : result.error)}</PreviewBlock>
          </Block>
        ) : null}
        {form.actionKind === "script" || checking ? (
          <Block>
            <ScriptTest
              kind={checking ? "check" : "action"}
              form={form}
              projects={projects}
              sample={checking ? null : formSampleTask(form, tasks)}
            />
          </Block>
        ) : null}
        {needs.length > 0 ? (
          <Block>
            <Field
              label="Variables it reads"
              hint="Found in what it names; one built at run time isn't seen. A project with no value for one gets no run of it, and the preview fills it in empty."
            >
              <VariableNeedsList needs={needs} />
            </Field>
          </Block>
        ) : null}
      </StepCard>

      <StepCard title="Name">
        <Block>
          <Field label="Name" hint={isNew ? undefined : "Renaming keeps its switches and run history."}>
            <Input
              size="sm"
              aria-label="Automation name"
              maxLength={CUSTOM_NAME_MAX}
              value={form.name}
              onChange={(event) => patch({ name: event.currentTarget.value })}
            />
          </Field>
          {isNew ? (
            <p className="text-xs text-muted-foreground">
              Save in Preview and it records what it would do, and does none of it, until you turn it on
              {checking || form.actionKind === "script"
                ? form.actionKind === "script"
                  ? ". The script is skipped in Preview."
                  : ". Its check script still runs for real in Preview; the agent doesn't."
                : ": no agent starts. Switch it on once its Preview runs look right."}
            </p>
          ) : null}
          {customId ? (
            <div>
              <RunHistoryLink automation={customAutomationKey(customId)} />
            </div>
          ) : null}
        </Block>
      </StepCard>
    </div>
  );
}

/** The "I've read it" switch for a script someone else wrote, as on an import, under its warning. */
export function ScriptConfirm({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsGroup>
      <Block>
        <ScriptWarning>
          <p>Someone else wrote this script. Read it on Details before you save it.</p>
        </ScriptWarning>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm">I&apos;ve read the script and I understand it runs on my machine as me</span>
          <Switch
            aria-label="Confirm the script runs on your machine"
            checked={checked}
            onCheckedChange={onCheckedChange}
          />
        </div>
      </Block>
    </SettingsGroup>
  );
}

function PreviewBlock({ children }: { children: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
      {children}
    </pre>
  );
}

/** The action's model: inherit (the board's model for the operation, then the task's), a tier, or any model. */
function ActionModelPicker({
  value,
  isSchedule,
  needs,
  onChange,
}: {
  value: ModelChoice;
  isSchedule: boolean;
  /** What its runs ask beyond the operation (a schema, tools, untrusted items), so providers that can't grey out. */
  needs: readonly OperationNeed[];
  onChange: (model: ModelChoice) => void;
}) {
  const settings = useSettings().data;
  if (!settings) return null;
  const op = isSchedule ? "customDetached" : "customTask";
  return (
    <ModelChoicePicker
      op={op}
      needs={needs}
      value={value}
      inherit={{ label: "Inherit", detail: inheritDetail(op, { needs }, settings) }}
      ariaLabel="Model"
      size="sm"
      className="w-full justify-between"
      onChange={(next) => onChange(next ?? INHERIT)}
    />
  );
}
