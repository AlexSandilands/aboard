import {
  CUSTOM_COMMAND_MAX,
  CUSTOM_MINUTES_MAX,
  CUSTOM_MINUTES_MIN,
  CUSTOM_NAME_MAX,
  CUSTOM_PLACEHOLDERS,
  CUSTOM_PROMPT_MAX,
  customEnvName,
  MODEL_TIERS,
} from "@repo/contracts";
import { type ReactNode, useState } from "react";
import { WEEKDAYS } from "~/components/recurring/recurring.logic";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { EditorFooter, EditorHeader, EditorPanel, EditorTitle } from "~/components/settings/EditorFrame";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useCreateCustomAutomation, useUpdateCustomAutomation } from "~/state/customAutomations";
import { useBoard } from "~/state/queries";
import {
  customFormToInput,
  previewAction,
  PR_EVENTS,
  sampleTask,
  STATUSES,
  TRIGGER_KINDS,
  type CustomForm,
} from "./customAutomations.logic";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Choice<T extends string>({
  label,
  value,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  value: T | "";
  items: ReadonlyArray<{ value: T | ""; label: string }>;
  onChange: (value: T | "") => void;
  placeholder?: string;
}) {
  return (
    <Select<string>
      items={items as ReadonlyArray<{ value: string; label: string }>}
      value={value}
      onValueChange={(next) => onChange((next ?? "") as T | "")}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

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
  const result = customFormToInput(form);
  const sample = result.ok && !isSchedule ? sampleTask(result.input, board?.tasks ?? []) : null;
  const preview = result.ok ? previewAction(result.input, sample, projects) : null;

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
      <EditorPanel className="space-y-4">
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

        <Field label="Do">
          <ToggleGroup
            aria-label="Action"
            value={[form.actionKind]}
            onValueChange={(next) => {
              const actionKind = next[0];
              if (actionKind === "agent" || actionKind === "shell") patch({ actionKind });
            }}
          >
            <Toggle value="agent">Start an agent</Toggle>
            <Toggle value="shell">Run a command</Toggle>
          </ToggleGroup>
        </Field>

        {form.actionKind === "agent" ? (
          <>
            <Field
              label="Prompt"
              hint={
                <>
                  Fill in{" "}
                  {CUSTOM_PLACEHOLDERS.map((p, i) => (
                    <span key={p.key}>
                      {i > 0 ? ", " : null}
                      <code className="font-mono">{`{{${p.key}}}`}</code>
                    </span>
                  ))}
                  .{" "}
                  {isSchedule
                    ? "The project's name and folder are added after it."
                    : "The task's details are added after it."}
                </>
              }
            >
              <Textarea
                aria-label="Prompt"
                maxLength={CUSTOM_PROMPT_MAX}
                value={form.prompt}
                placeholder="The checks on {{pr.url}} are failing. Find out why and push a fix."
                onChange={(event) => patch({ prompt: event.currentTarget.value })}
              />
            </Field>
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
                own, and can use the board&apos;s tools to find its work. It doesn&apos;t run in T3 Code.
              </p>
            ) : (
              <div className="flex items-start justify-between gap-4">
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">Work on the pull request&apos;s branch</span>
                  <span className="block text-xs text-muted-foreground">
                    When the task has an open pull request, the agent pushes to it instead of starting a new branch.
                  </span>
                </span>
                <Switch
                  aria-label="Work on the pull request's branch"
                  checked={form.onPrBranch}
                  onCheckedChange={(onPrBranch) => patch({ onPrBranch })}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The runner, budget and timeout are this automation&apos;s settings in the Autopilot list, per scope.
            </p>
          </>
        ) : (
          <>
            <Field
              label="Command"
              hint={
                <>
                  Runs in the project&apos;s folder, in sh (PowerShell on Windows). It is never filled in: read the task
                  from{" "}
                  {CUSTOM_PLACEHOLDERS.map((p, i) => (
                    <span key={p.key}>
                      {i > 0 ? ", " : null}
                      <code className="font-mono">{customEnvName(p.env)}</code>
                    </span>
                  ))}
                  , as <code className="font-mono">&quot;$NAME&quot;</code> in sh or{" "}
                  <code className="font-mono">$env:NAME</code> in PowerShell.
                </>
              }
            >
              <Textarea
                aria-label="Command"
                className="font-mono"
                maxLength={CUSTOM_COMMAND_MAX}
                value={form.command}
                placeholder="./scripts/notify.sh"
                onChange={(event) => patch({ command: event.currentTarget.value })}
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
            <Alert variant="warning">
              <AlertDescription>
                The command runs on this machine as you, whenever the trigger fires in a project it is on in. On
                Windows, don&apos;t pass a value as an argument to another program: PowerShell doesn&apos;t escape the
                quotes in it, and .cmd programs such as npm and pnpm hand it to cmd.exe, so a task title could add a
                command. Let the program read the variable itself.
              </AlertDescription>
            </Alert>
          </>
        )}

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

        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </EditorPanel>
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
