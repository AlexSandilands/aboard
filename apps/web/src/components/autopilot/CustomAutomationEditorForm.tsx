import {
  CUSTOM_COMMAND_MAX,
  CUSTOM_MINUTES_MAX,
  CUSTOM_MINUTES_MIN,
  CUSTOM_NAME_MAX,
  CUSTOM_PROMPT_MAX,
  customAutomationKey,
  CustomAction,
  inputEnvName,
  MODEL_TIERS,
} from "@repo/contracts";
import {
  BotIcon,
  EyeIcon,
  FileCode2Icon,
  FolderGit2Icon,
  type LucideIcon,
  PlayIcon,
  SquareTerminalIcon,
  TagIcon,
  ZapIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { WEEKDAYS } from "~/components/recurring/recurring.logic";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { EditorFooter, EditorHeader, EditorTitle } from "~/components/settings/EditorFrame";
import { SettingsGroup, SettingsRow, SettingsSectionHeader } from "~/components/settings/settingsLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { useCreateCustomAutomation, useUpdateCustomAutomation } from "~/state/customAutomations";
import { useBoard, useSettings } from "~/state/queries";
import {
  customFormToInput,
  emptyFormSlots,
  formSampleTask,
  parseAllowedTools,
  previewAction,
  PR_EVENTS,
  sampleTask,
  STATUSES,
  TRIGGER_KINDS,
  withActionKind,
  withCheck,
  type CustomForm,
} from "./customAutomations.logic";
import { Choice, Field } from "./FormFields";
import { BlockedWarning, InputsField, SlotsField } from "./InputsAndSlots";
import { RunHistoryLink } from "./RunHistoryLink";
import { ScriptField } from "./ScriptField";
import { ScriptWarning } from "./ScriptWarning";
import { InsertChips, insertIntoTextarea } from "./InsertChips";
import { insertChips, knownVariables } from "./insertChips.logic";
import { SdkStatusBar } from "./SdkStatusBar";
import { VariableNeedsList } from "./VariablesEditor";
import { variableNeeds } from "./variables.logic";

/** The shell a command runs in here, for the examples: PowerShell on Windows, sh elsewhere. */
const COMMAND_SHELL = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "powershell" : "sh";

const INPUTS_FOR_CODE_HINT = `Optional. Values it reads as ${inputEnvName("<name>")} (or inputs on stdin, for a script), declared so whoever imports a shared file fills them in without editing the code.`;

/**
 * The body of the custom automation editor: trigger, filters, action and a preview of what it would run for a task
 * on the board. It is a settings sub-page. `customId` is null for a new automation.
 */
export function CustomAutomationEditorForm({
  customId,
  initial,
  onDone,
  onCancel,
}: {
  customId: string | null;
  initial: CustomForm;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const board = useBoard().data;
  const create = useCreateCustomAutomation();
  const update = useUpdateCustomAutomation();
  const pending = create.isPending || update.isPending;
  const patch = (next: Partial<CustomForm>) => setForm((current) => ({ ...current, ...next }));

  const projects = board?.projects.filter((p) => p.archivedAt === null) ?? [];
  const epics = (board?.tasks ?? []).filter(
    (t) =>
      t.kind === "epic" &&
      t.archivedAt === null &&
      (form.projectIds.length === 0 || form.projectIds.includes(t.projectId)),
  );
  const isSchedule = form.triggerKind === "schedule";
  // Only a schedule can check first: an agent for a task already has its item, the task.
  const checking = isSchedule && form.actionKind === "agent" && form.checkOn;
  const result = customFormToInput(form);
  const sample = result.ok && !isSchedule ? sampleTask(result.input, board?.tasks ?? []) : null;
  const boardVariables = useSettings().data?.automationVariables ?? [];
  const variables = knownVariables(boardVariables, projects);
  const inputNames = form.inputs.map((i) => i.name);
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const commandBox = useRef<HTMLTextAreaElement>(null);
  const preview = result.ok ? previewAction(result.input, sample, projects, boardVariables) : null;
  // The variables the action reads, and the projects it could run in that have no value for each.
  const needs = result.ok
    ? variableNeeds(
        CustomAction.parse(result.input.action),
        boardVariables,
        projects.filter((p) => form.projectIds.length === 0 || form.projectIds.includes(p.id)),
      )
    : [];

  const save = () => {
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    const done = { onSuccess: onDone };
    if (customId) update.mutate({ id: customId, ...result.input }, done);
    else create.mutate(result.input, done);
  };

  return (
    <>
      <EditorHeader>
        <EditorTitle>{customId ? "Edit custom automation" : "New custom automation"}</EditorTitle>
        <p className="text-sm text-muted-foreground">
          Say what to watch for and what to do. It is switched on and off per project like the built-in automations, and
          keeps to the same pause, dry run and limits. It only acts on what happens after it is switched on.
        </p>
      </EditorHeader>
      <div className="space-y-6">
        <FormSection title="Automation" icon={TagIcon}>
          <Block>
            <Field label="Name">
              <Input
                autoFocus
                size="sm"
                aria-label="Automation name"
                maxLength={CUSTOM_NAME_MAX}
                value={form.name}
                placeholder="Fix failing checks"
                onChange={(event) => patch({ name: event.currentTarget.value })}
              />
            </Field>
          </Block>
        </FormSection>

        <FormSection title="Trigger" icon={ZapIcon}>
          <Block>
            <Field label="When">
              <Choice
                label="Trigger"
                value={form.triggerKind}
                items={TRIGGER_KINDS}
                onChange={(triggerKind) => triggerKind && patch({ triggerKind })}
              />
            </Field>

            {form.triggerKind === "status_change" ? (
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
            ) : null}
            {form.triggerKind === "pr_event" ? (
              <Field label="A pull request linked to the task">
                <Choice
                  label="Pull request event"
                  value={form.prEvent}
                  items={PR_EVENTS}
                  onChange={(prEvent) => prEvent && patch({ prEvent })}
                />
              </Field>
            ) : null}
            {form.triggerKind === "stale" ? (
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
            ) : null}
            {isSchedule ? (
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
            ) : null}
          </Block>
        </FormSection>

        <FormSection title="Where" icon={FolderGit2Icon}>
          <Block>
            <Field label="Only in these projects" hint="None picked is every project it is switched on in.">
              <ToggleGroup
                multiple
                aria-label="Projects"
                className="flex-wrap"
                value={form.projectIds}
                onValueChange={(projectIds) => patch({ projectIds })}
              >
                {projects.map((p) => (
                  <Toggle key={p.id} value={p.id}>
                    {p.title}
                  </Toggle>
                ))}
              </ToggleGroup>
            </Field>
            {isSchedule ? null : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="With any of these labels" hint="Comma-separated; blank is any task.">
                  <Input
                    size="sm"
                    aria-label="Labels"
                    value={form.labels}
                    placeholder="ui, backend"
                    onChange={(event) => patch({ labels: event.currentTarget.value })}
                  />
                </Field>
                <Field label="In the epic">
                  <Choice
                    label="Epic"
                    value={form.epicId}
                    items={[
                      { value: "", label: "Any task" },
                      ...epics.map((e) => ({ value: e.id, label: `#${e.number} ${e.title}` })),
                    ]}
                    onChange={(epicId) => patch({ epicId })}
                  />
                </Field>
              </div>
            )}
          </Block>
        </FormSection>

        <FormSection title="Action" icon={PlayIcon}>
          <Block>
            <ActionPicker
              value={form.actionKind}
              onChange={(actionKind) => setForm((current) => withActionKind(current, actionKind))}
            />
          </Block>
          {form.actionKind === "agent" ? (
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
                      inputs: inputNames,
                      variables,
                      hasTask: !isSchedule,
                      checking,
                    })}
                    onInsert={(text) => insertIntoTextarea(promptBox.current, text, (prompt) => patch({ prompt }))}
                  />
                  <Textarea
                    ref={promptBox}
                    aria-label="Prompt"
                    maxLength={CUSTOM_PROMPT_MAX}
                    value={form.prompt}
                    placeholder="The checks on {{pr.url}} are failing. Find out why and push a fix."
                    onChange={(event) => patch({ prompt: event.currentTarget.value })}
                  />
                </Field>
              </Block>
              {isSchedule ? (
                <>
                  <SwitchRow
                    title="Check first with a script"
                    description="Runs before any agent. Each JSON line it prints is an item, and each item it hasn't printed before starts an agent of its own; printing nothing starts nothing, so a quiet check costs nothing."
                    checked={form.checkOn}
                    onCheckedChange={(checkOn) => setForm((current) => withCheck(current, checkOn))}
                  />
                  {form.checkOn ? (
                    <>
                      <Block>
                        <ScriptWarning />
                        <ScriptField kind="check" form={form} patch={patch} projects={projects} sample={null} />
                      </Block>
                      <SwitchRow
                        title="Treat the items as untrusted"
                        description="Items often carry text anyone can write, such as a pull request title or comment. On, each item's agent runs read-only with only this board's tools, and not the ones that reach other agents or merge. It can't be combined with allowed tools or tool slots."
                        checked={form.untrustedItems}
                        onCheckedChange={(untrustedItems) => patch({ untrustedItems })}
                      />
                      {form.untrustedItems ? null : (
                        <Block>
                          <Alert variant="warning">
                            <AlertDescription>
                              Each item&apos;s agent gets the same access as any scheduled agent here, including
                              writing, and it reads text the check copied from outside. Only turn this off when whoever
                              can write that text is trusted.
                            </AlertDescription>
                          </Alert>
                        </Block>
                      )}
                    </>
                  ) : null}
                </>
              ) : null}
              <Block>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Skill" hint="Optional. The agent is told to use it.">
                    <Input
                      size="sm"
                      aria-label="Skill"
                      value={form.skill}
                      placeholder="fix-ci"
                      onChange={(event) => patch({ skill: event.currentTarget.value })}
                    />
                  </Field>
                  <Field label="Model tier">
                    <Choice
                      label="Model tier"
                      value={form.tier}
                      items={[
                        { value: "", label: isSchedule ? "The default tier" : "The task's tier" },
                        ...MODEL_TIERS.map((t) => ({ value: t.value, label: t.label })),
                      ]}
                      onChange={(tier) => patch({ tier })}
                    />
                  </Field>
                </div>
                {isSchedule ? (
                  <p className="text-xs text-muted-foreground">
                    A scheduled agent has no task: it runs headless in an empty temporary folder, not the project&apos;s
                    own, and can use the board&apos;s tools to find its work. It doesn&apos;t run in T3 Code. Each run
                    ends with a short handover that the next run in the same project is given, so it can remember what
                    it held, triggered or skipped.
                  </p>
                ) : null}
              </Block>
              {isSchedule ? null : (
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
                      Optional, one per line. A whole MCP server (<code className="font-mono">mcp__issue-tracker</code>)
                      or one of its tools (<code className="font-mono">mcp__issue-tracker__search_jira</code>). The
                      board&apos;s own tools are always allowed.
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
                      These tools run unattended: nobody is asked to approve a call, so the agent can use everything
                      they offer, including anything that writes. Allow a single tool rather than a whole server when
                      you can. The server must be one of your own (
                      <code className="font-mono">claude mcp add --scope user</code>, a plugin or a connector): a server
                      from a project&apos;s <code className="font-mono">.mcp.json</code> needs an approval nobody can
                      give in an unattended run. An agent with extra tools runs headless, not in a T3 Code thread.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </Block>
              <Block>
                <Field
                  label="Inputs"
                  hint="Optional. Values the prompt reads as {{inputs.name}}. A shared file asks whoever imports it to fill them in, so they never edit the prompt."
                >
                  <InputsField inputs={form.inputs} onChange={(inputs) => patch({ inputs })} />
                </Field>
                <Field
                  label="Required tools"
                  hint="Optional. Tools the automation needs but can't name, since people use different MCP servers: Jira search, say. The prompt is told which tools fill each slot. Sharing it leaves the tools out."
                >
                  <SlotsField slots={form.slots} onChange={(slots) => patch({ slots })} />
                </Field>
                {emptyFormSlots(form).length > 0 ? (
                  <BlockedWarning
                    reason={`Won't work until you fill in: ${emptyFormSlots(form)
                      .map((slot) => slot.label || slot.name || "a tool slot")
                      .join(", ")}`}
                  />
                ) : null}
                <p className="text-xs text-muted-foreground">
                  The runner, budget and timeout are this automation&apos;s settings in the Autopilot list, per scope.
                </p>
              </Block>
            </>
          ) : form.actionKind === "script" ? (
            <>
              <Block>
                <ScriptWarning />
                <ScriptField
                  kind="action"
                  form={form}
                  patch={patch}
                  projects={projects}
                  sample={formSampleTask(form, board?.tasks ?? [])}
                />
              </Block>
              <Block>
                <Field label="Inputs" hint={INPUTS_FOR_CODE_HINT}>
                  <InputsField inputs={form.inputs} onChange={(inputs) => patch({ inputs })} />
                </Field>
              </Block>
            </>
          ) : (
            <>
              <Block>
                <Field
                  label="Command"
                  hint={
                    <>
                      Runs in the project&apos;s folder, in sh (PowerShell on Windows). It is never filled in: read
                      values from the environment, as <code className="font-mono">&quot;$NAME&quot;</code> in sh or{" "}
                      <code className="font-mono">$env:NAME</code> in PowerShell.
                    </>
                  }
                >
                  <InsertChips
                    chips={insertChips({ target: COMMAND_SHELL, inputs: inputNames, variables, hasTask: !isSchedule })}
                    onInsert={(text) => insertIntoTextarea(commandBox.current, text, (command) => patch({ command }))}
                  />
                  <Textarea
                    ref={commandBox}
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
              <Block>
                <Field label="Inputs" hint={INPUTS_FOR_CODE_HINT}>
                  <InputsField inputs={form.inputs} onChange={(inputs) => patch({ inputs })} />
                </Field>
              </Block>
              <Block>
                <Alert variant="warning">
                  <AlertDescription>
                    The command runs on this machine as you, whenever the trigger fires in a project it is on in. On
                    Windows, don&apos;t pass a value as an argument to another program: PowerShell doesn&apos;t escape
                    the quotes in it, and .cmd programs such as npm and pnpm hand it to cmd.exe, so a task title could
                    add a command. Let the program read the variable itself.
                  </AlertDescription>
                </Alert>
              </Block>
            </>
          )}
        </FormSection>

        <FormSection title="Preview" icon={EyeIcon}>
          <Block>
            <Field
              label="Preview"
              hint={
                sample
                  ? `For #${sample.number} ${sample.title}, the newest task it could act on.`
                  : isSchedule
                    ? "For the first project it could run in."
                    : "No task on the board fits the filters yet."
              }
            >
              <pre className="max-h-56 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-2xs whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">
                {preview ?? (result.ok ? "Nothing to preview." : result.error)}
              </pre>
            </Field>

            {needs.length > 0 ? (
              <Field
                label="Variables it reads"
                hint="Found in what it names; one built at run time isn't seen. A project with no value for one gets no run of it, and the preview fills it in empty."
              >
                <VariableNeedsList needs={needs} />
              </Field>
            ) : null}

            {customId && isSchedule && form.actionKind === "agent" ? (
              <Field
                label="Run history"
                hint="What each run said it did, and the handover it left for the next run in that project."
              >
                <div>
                  <RunHistoryLink automation={customAutomationKey(customId)} />
                </div>
              </Field>
            ) : null}
          </Block>
        </FormSection>

        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
      <EditorFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={save}>
          {customId ? "Save automation" : "Create automation"}
        </Button>
      </EditorFooter>
    </>
  );
}

/** A titled card of the editor, laid out like a settings section: each child is a block, with a line between. */
function FormSection({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <SettingsSectionHeader title={title} status={<Icon aria-hidden className="size-3.5" />} />
      <SettingsGroup>{children}</SettingsGroup>
    </section>
  );
}

function Block({ children }: { children: ReactNode }) {
  return <div className="space-y-4 px-3 py-4 sm:px-4">{children}</div>;
}

/** An on/off option of the form, as a settings row with the switch on its right. */
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

const ACTIONS: {
  value: CustomForm["actionKind"];
  title: string;
  description: string;
  icon: LucideIcon;
  tint: string;
}[] = [
  {
    value: "agent",
    title: "Start an agent",
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

/** What the automation does, as three cards like the Appearance page's theme choice. */
function ActionPicker({
  value,
  onChange,
}: {
  value: CustomForm["actionKind"];
  onChange: (value: CustomForm["actionKind"]) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Action" className="grid gap-2 sm:grid-cols-3">
      {ACTIONS.map((action) => {
        const picked = action.value === value;
        const Icon = action.icon;
        return (
          <button
            key={action.value}
            type="button"
            role="radio"
            aria-checked={picked}
            onClick={() => onChange(action.value)}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              picked
                ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                : "border-border/60 hover:border-border hover:bg-accent/40",
            )}
          >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", action.tint)}>
              <Icon aria-hidden className="size-4" />
            </span>
            <span className="min-w-0 space-y-0.5">
              <span className={cn("block text-sm", picked ? "font-medium text-foreground" : "text-foreground/85")}>
                {action.title}
              </span>
              <span className="block text-xs text-muted-foreground">{action.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
