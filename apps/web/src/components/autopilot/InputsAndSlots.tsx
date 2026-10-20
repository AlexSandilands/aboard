import { type AutomationInputType, CUSTOM_INPUTS_MAX, CUSTOM_SLOTS_MAX } from "@repo/contracts";
import { PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { blankInput, blankSlot, type FormInput, type FormSlot } from "./customAutomations.logic";

const INPUT_TYPES: ReadonlyArray<{ value: AutomationInputType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes / no" },
];

function Labelled({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-2xs font-medium text-foreground/70">{label}</span>
      {children}
    </label>
  );
}

/**
 * The value of one input, with the control its type needs. `onChange` gets the text the server stores: a number as
 * typed, `true` or `false` for yes / no.
 */
export function InputValueControl({
  input,
  onChange,
  label,
}: {
  input: Pick<FormInput, "type" | "value">;
  onChange: (value: string) => void;
  label: string;
}) {
  if (input.type === "boolean") {
    return (
      <ToggleGroup
        aria-label={label}
        value={[input.value === "true" ? "true" : "false"]}
        onValueChange={(next) => next[0] && onChange(next[0])}
      >
        <Toggle value="true">Yes</Toggle>
        <Toggle value="false">No</Toggle>
      </ToggleGroup>
    );
  }
  return (
    <Input
      size="sm"
      aria-label={label}
      type={input.type === "number" ? "number" : "text"}
      value={input.value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/** The inputs the prompt reads as `{{inputs.<name>}}`: what each is called, what kind of value, and its value. */
export function InputsField({ inputs, onChange }: { inputs: FormInput[]; onChange: (inputs: FormInput[]) => void }) {
  const patch = (index: number, next: Partial<FormInput>) =>
    onChange(inputs.map((input, i) => (i === index ? { ...input, ...next } : input)));
  return (
    <div className="flex flex-col gap-2">
      {inputs.map((input, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows are controlled and have no id of their own
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border/50 p-2.5">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Labelled label="Name in the prompt">
              <Input
                size="sm"
                font="mono"
                aria-label={`Input ${i + 1} name`}
                value={input.name}
                placeholder="look_back"
                onChange={(event) => patch(i, { name: event.currentTarget.value })}
              />
            </Labelled>
            <Labelled label="Label">
              <Input
                size="sm"
                aria-label={`Input ${i + 1} label`}
                value={input.label}
                placeholder="Days to look back"
                onChange={(event) => patch(i, { label: event.currentTarget.value })}
              />
            </Labelled>
            <Labelled label="Kind">
              <Select<string>
                items={INPUT_TYPES}
                value={input.type}
                onValueChange={(type) => {
                  if (type === "text" || type === "number" || type === "boolean") {
                    // A yes / no input starts at a valid value instead of whatever was typed for the old kind.
                    patch(i, { type, ...(type === "boolean" ? { value: "false" } : {}) });
                  }
                }}
              >
                <SelectTrigger size="sm" aria-label={`Input ${i + 1} kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {INPUT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Labelled>
          </div>
          <div className="flex items-end justify-between gap-2">
            <Labelled label="Value" className="flex-1">
              <InputValueControl
                input={input}
                label={`${input.label || `Input ${i + 1}`} value`}
                onChange={(value) => patch(i, { value })}
              />
            </Labelled>
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={`Remove input ${i + 1}`}
              onClick={() => onChange(inputs.filter((_, j) => j !== i))}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      ))}
      {inputs.length < CUSTOM_INPUTS_MAX ? (
        <div>
          <Button size="xs" variant="outline" onClick={() => onChange([...inputs, blankInput()])}>
            <PlusIcon />
            Add input
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The required tool slots: what each is for, and the tools that fill it, one per line. */
export function SlotsField({ slots, onChange }: { slots: FormSlot[]; onChange: (slots: FormSlot[]) => void }) {
  const patch = (index: number, next: Partial<FormSlot>) =>
    onChange(slots.map((slot, i) => (i === index ? { ...slot, ...next } : slot)));
  return (
    <div className="flex flex-col gap-2">
      {slots.map((slot, i) => (
        // oxlint-disable-next-line react/no-array-index-key -- rows are controlled and have no id of their own
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border/50 p-2.5">
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr]">
            <Labelled label="Name">
              <Input
                size="sm"
                font="mono"
                aria-label={`Slot ${i + 1} name`}
                value={slot.name}
                placeholder="jira"
                onChange={(event) => patch(i, { name: event.currentTarget.value })}
              />
            </Labelled>
            <Labelled label="Label">
              <Input
                size="sm"
                aria-label={`Slot ${i + 1} label`}
                value={slot.label}
                placeholder="Jira tools"
                onChange={(event) => patch(i, { label: event.currentTarget.value })}
              />
            </Labelled>
          </div>
          <Labelled label="What the tools are for">
            <Input
              size="sm"
              aria-label={`Slot ${i + 1} description`}
              value={slot.description}
              placeholder="search issues by JQL and read an issue"
              onChange={(event) => patch(i, { description: event.currentTarget.value })}
            />
          </Labelled>
          <Labelled label="Tools, one per line">
            <Textarea
              aria-label={`${slot.label || `Slot ${i + 1}`} tools`}
              className="font-mono"
              rows={2}
              value={slot.tools}
              placeholder={"mcp__issue-tracker__search_jira\nmcp__issue-tracker__get_jira_issue"}
              onChange={(event) => patch(i, { tools: event.currentTarget.value })}
            />
          </Labelled>
          <div className="flex justify-end">
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={`Remove slot ${i + 1}`}
              onClick={() => onChange(slots.filter((_, j) => j !== i))}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>
      ))}
      {slots.length < CUSTOM_SLOTS_MAX ? (
        <div>
          <Button size="xs" variant="outline" onClick={() => onChange([...slots, blankSlot()])}>
            <PlusIcon />
            Add tool slot
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The notice for an automation that names a variable some projects it is on in have no value for: it skips them. */
export function NeedsVariablesWarning({ needs }: { needs: string }) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle className="text-sm">{needs}</AlertTitle>
      <AlertDescription>
        It doesn&apos;t run in those projects until the variable has a value there: set it in the project&apos;s
        settings, or for every project under Settings → Autopilot → Custom automations.
      </AlertDescription>
    </Alert>
  );
}

/** The orange notice for an automation with a required tool slot nobody has filled: it can't be switched on. */
export function BlockedWarning({ reason }: { reason: string }) {
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle className="text-sm">{reason}</AlertTitle>
      <AlertDescription>
        A required tool slot is empty, so it can&apos;t be switched on yet. Fill it with tools from one of your own MCP
        servers.
      </AlertDescription>
    </Alert>
  );
}
