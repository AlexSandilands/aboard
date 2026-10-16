import { RECURRING_NAME_MAX } from "@repo/contracts";
import { type ReactNode, useState } from "react";
import { Button } from "~/components/ui/button";
import { DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useCreateRecurringRule, useUpdateRecurringRule } from "~/state/recurring";
import { useTemplates } from "~/state/queries";
import { formToInput, usableTemplates, WEEKDAYS, type RuleForm } from "./recurring.logic";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {children}
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/**
 * The body of the recurring rule editor: a header, the fields and Save. It takes over the project settings dialog.
 * `ruleId` is null for a new rule. `onDone` runs after a save, `onCancel` on Cancel.
 */
export function RuleEditorForm({
  projectId,
  ruleId,
  initial,
  onDone,
  onCancel,
}: {
  projectId: string;
  ruleId: string | null;
  initial: RuleForm;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const templates = useTemplates();
  const create = useCreateRecurringRule(projectId);
  const update = useUpdateRecurringRule();
  const pending = create.isPending || update.isPending;
  const patch = (next: Partial<RuleForm>) => setForm((current) => ({ ...current, ...next }));

  const usable = usableTemplates(templates.data ?? [], projectId);
  const templateItems = usable.map((t) => ({
    value: t.id,
    label: t.projectId === null ? t.name : `${t.name} (this project)`,
  }));

  const save = () => {
    const result = formToInput(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    const done = { onSuccess: onDone };
    if (ruleId) update.mutate({ id: ruleId, ...result.input }, done);
    else create.mutate(result.input, done);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{ruleId ? "Edit recurring task" : "New recurring task"}</DialogTitle>
        <p className="text-sm text-muted-foreground">
          Creates a task from a template on a schedule, in local time. It waits while the task it made last time is
          still open, so a chore nobody has done doesn&apos;t pile up.
        </p>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              autoFocus
              size="sm"
              aria-label="Rule name"
              maxLength={RECURRING_NAME_MAX}
              value={form.name}
              placeholder="Weekly dependency bumps"
              onChange={(event) => patch({ name: event.currentTarget.value })}
            />
          </Field>
          <Field
            label="Template"
            hint={
              templateItems.length === 0
                ? "No template with a title pattern yet. Add one in Settings."
                : "Its title pattern names each task; its plan, if any, starts it in Planned."
            }
          >
            <Select
              items={templateItems}
              value={form.templateId || null}
              onValueChange={(value) => patch({ templateId: value ?? "" })}
            >
              <SelectTrigger size="sm" aria-label="Template">
                <SelectValue placeholder="Pick a template" />
              </SelectTrigger>
              <SelectPopup>
                {templateItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        </div>

        <Field label="Repeats">
          <ToggleGroup
            aria-label="Repeat"
            value={[form.kind]}
            onValueChange={(next) => {
              const kind = next[0];
              if (kind === "weekly" || kind === "every") patch({ kind });
            }}
          >
            <Toggle value="weekly">On weekdays</Toggle>
            <Toggle value="every">Every few days</Toggle>
          </ToggleGroup>
        </Field>

        {form.kind === "weekly" ? (
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
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Every (days)">
              <Input
                size="sm"
                type="number"
                min={1}
                max={365}
                aria-label="Repeat every N days"
                value={form.everyDays}
                onChange={(event) => patch({ everyDays: event.currentTarget.value })}
              />
            </Field>
            <Field label="Starting" hint="Counted from this day.">
              <Input
                size="sm"
                type="date"
                aria-label="Start date"
                value={form.startDate}
                onChange={(event) => patch({ startDate: event.currentTarget.value })}
              />
            </Field>
          </div>
        )}

        <Field label="At" hint="Local time. If the board was off at that time, one task is made when it is back.">
          <Input
            size="sm"
            type="time"
            aria-label="Time of day"
            className="sm:w-36"
            value={form.time}
            onChange={(event) => patch({ time: event.currentTarget.value })}
          />
        </Field>

        <div className="flex items-start justify-between gap-4">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">Flag for Autopilot</span>
            <span className="block text-xs text-muted-foreground">
              New tasks carry the Autopilot flag, so Start planned tasks may pick them up once planned.
            </span>
          </span>
          <Switch
            aria-label="Flag for Autopilot"
            checked={form.flagAutopilot}
            onCheckedChange={(checked) => patch({ flagAutopilot: checked })}
          />
        </div>
        <div className="flex items-start justify-between gap-4">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">Enabled</span>
            <span className="block text-xs text-muted-foreground">
              A paused rule makes nothing, and doesn&apos;t catch up when it is switched on again.
            </span>
          </span>
          <Switch
            aria-label="Enabled"
            checked={form.enabled}
            onCheckedChange={(checked) => patch({ enabled: checked })}
          />
        </div>

        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={pending} onClick={save}>
          {ruleId ? "Save rule" : "Create rule"}
        </Button>
      </DialogFooter>
    </>
  );
}
