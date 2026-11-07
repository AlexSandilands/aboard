import {
  INHERIT,
  parseModelChoice,
  ReviewSkillRef,
  type AutopilotConfig,
  type AutopilotAutomation,
  type AutopilotField,
  type AutopilotScopeEntry,
} from "@repo/contracts";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { skillOptions } from "~/components/review/review.logic";
import { inheritDetail } from "~/components/models/choicePicker.logic";
import { ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import { ReviewSkillSelect } from "~/components/settings/ReviewSettingsSection";
import { SETTINGS_TEXT_WIDTH, SettingResetButton, SettingsRow, UnitInput } from "~/components/settings/settingsLayout";
import { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotScope, useSettings, useSkills } from "~/state/queries";
import { toastManager } from "~/components/ui/toast";
import { entryFor, fieldText, isClockTime, parseNumberField, withConfigValue } from "./autopilot.logic";
import { TimeInput } from "./TimeInput";

/** Sets or clears one key of a scope's config, built from the latest saved config (see useSetAutopilotScope). */
export type ConfigUpdate = (update: (current: AutopilotConfig) => AutopilotConfig) => void;

export interface AutomationItem {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  onMode: (mode: AutopilotScopeEntry["mode"]) => void;
  onConfig: ConfigUpdate;
}

/**
 * Every automation at the board, with its entry there and the board's setters, or the message to show instead while
 * loading, on an error or with no automations. Where an automation runs below the board is the Where it runs widget's.
 */
export function useBoardAutomations() {
  const overview = useAutopilotOverview();
  const scope = useAutopilotScope(null);
  // Bumped when the server rejects a save, so the form controls drop the text it refused.
  const [rejected, setRejected] = useState(0);
  const set = useSetAutopilotScope(null, () => setRejected((n) => n + 1));
  const automations = overview.data?.automations;
  const failed = overview.error ?? scope.error;
  // The forms send a scope's whole config, so they wait for the real entries rather than editing stand-ins.
  const loaded = automations && scope.data;
  if (!loaded) return { message: failed ? failed.message : "Loading automations...", items: [] };
  if (automations.length === 0) return { message: "No automations are installed yet.", items: [] };
  const items = automations.map((automation): AutomationItem => ({
    automation,
    entry: entryFor(scope.data, automation),
    onMode: (mode) => set.mutate({ automation: automation.key, mode }),
    onConfig: (config) => set.mutate({ automation: automation.key, config }),
  }));
  return { message: null, items, pending: set.isPending, rejected };
}

/**
 * One config field of an automation as a settings row: its label and help on the left, its control at the right edge
 * (a multiline field's under them, full width), and a reset beside the title while it is set at this scope.
 */
export function AutomationField({
  automation,
  field,
  entry,
  projectId,
  rejected,
  onConfig,
}: {
  automation: AutopilotAutomation;
  field: AutopilotField;
  entry: AutopilotScopeEntry;
  projectId: string | null;
  rejected: number;
  onConfig: ConfigUpdate;
}) {
  const overridden = field.key in entry.config;
  const value = field.key in entry.effectiveConfig ? entry.effectiveConfig[field.key] : automation.defaults[field.key];
  // Clearing a key that isn't set here changes nothing; the control puts the inherited value back.
  const save = (next: unknown) => {
    if (next === undefined && !overridden) return false;
    onConfig((current) => withConfigValue(current, field.key, next));
    return true;
  };
  const control = (
    <FieldControl key={rejected} field={field} value={value} projectId={projectId} onSave={save} label={field.label} />
  );
  const multiline = field.kind === "text" && field.multiline;
  return (
    <SettingsRow
      title={field.label}
      description={field.help}
      resetAction={
        overridden ? (
          <SettingResetButton
            label={field.label}
            to={projectId ? "the board's value" : "default"}
            onClick={() => save(undefined)}
          />
        ) : undefined
      }
      control={multiline ? undefined : control}
    >
      {multiline ? <div className="mt-3">{control}</div> : null}
    </SettingsRow>
  );
}

function FieldControl({
  field,
  value,
  projectId,
  onSave,
  label,
}: {
  field: AutopilotField;
  value: unknown;
  projectId: string | null;
  /** Returns false when nothing was saved, so a text control can put the shown value back. */
  onSave: (next: unknown) => boolean;
  label: string;
}) {
  switch (field.kind) {
    case "boolean":
      return <Switch aria-label={label} checked={value === true} onCheckedChange={(checked) => onSave(checked)} />;
    case "number":
      return <NumberField key={fieldText(value)} field={field} value={value} onSave={onSave} />;
    case "text":
      if (field.multiline) {
        return (
          <Textarea
            key={fieldText(value)}
            aria-label={label}
            size="sm"
            placeholder={field.placeholder}
            defaultValue={fieldText(value)}
            onBlur={(event) => {
              const input = event.currentTarget;
              const next = input.value.trim();
              if (next === fieldText(value)) return;
              if (!onSave(next === "" ? undefined : next)) input.value = fieldText(value);
            }}
          />
        );
      }
      return (
        <Input
          key={fieldText(value)}
          aria-label={label}
          size="sm"
          className={SETTINGS_TEXT_WIDTH}
          placeholder={field.placeholder}
          defaultValue={fieldText(value)}
          onBlur={(event) => {
            const input = event.currentTarget;
            const next = input.value.trim();
            if (next === fieldText(value)) return;
            if (!onSave(next === "" ? undefined : next)) input.value = fieldText(value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      );
    case "select":
      return (
        <Select
          items={field.options}
          value={typeof value === "string" ? value : null}
          onValueChange={(next) => {
            if (next !== null) onSave(next);
          }}
        >
          <SelectTrigger size="sm" className={SETTINGS_TEXT_WIDTH} aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    case "time":
      return (
        <TimeInput
          label={label}
          // Anything that isn't HH:MM shows blank, which a time input accepts.
          value={typeof value === "string" && isClockTime(value) ? value : ""}
          onSave={onSave}
        />
      );
    case "model":
      return <ModelField field={field} value={value} label={label} onSave={onSave} />;
    case "skill":
      return (
        <SkillField
          projectId={projectId}
          value={value}
          label={label}
          builtinLabel={field.builtinLabel}
          onSave={onSave}
        />
      );
  }
}

/**
 * Which model the automation's runs start on: inherit (the board's model for the operation, then the task's), a tier,
 * a custom model, or a provider's model, in the shared picker that greys out providers the operation can't run on.
 */
function ModelField({
  field,
  value,
  label,
  onSave,
}: {
  field: Extract<AutopilotField, { kind: "model" }>;
  value: unknown;
  label: string;
  onSave: (next: unknown) => boolean;
}) {
  const settings = useSettings().data;
  if (!settings) return null;
  const op = field.operation ?? "customTask";
  return (
    <ModelChoicePicker
      op={op}
      needs={field.needs}
      value={parseModelChoice(value)}
      inherit={{ label: "Inherit", detail: inheritDetail(op, { needs: field.needs }, settings) }}
      ariaLabel={label}
      size="sm"
      className={SETTINGS_TEXT_WIDTH}
      onChange={(next) => onSave(next ?? INHERIT)}
    />
  );
}

/** A number saved on blur or Enter. Empty clears the key, so it inherits again; a value out of range is put back. */
function NumberField({
  field,
  value,
  onSave,
}: {
  field: Extract<AutopilotField, { kind: "number" }>;
  value: unknown;
  onSave: (next: unknown) => boolean;
}) {
  return (
    <UnitInput
      aria-label={field.label}
      unit={field.unit}
      defaultValue={fieldText(value)}
      onBlur={(event) => {
        const input = event.currentTarget;
        const next = parseNumberField(input.value, field);
        if (next === null) {
          input.value = fieldText(value);
          toastManager.add({
            type: "warning",
            title: `${field.label} not saved`,
            description: rangeHint(field),
          });
        } else if (next !== (typeof value === "number" ? value : undefined) && !onSave(next)) {
          input.value = fieldText(value);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function rangeHint(field: Extract<AutopilotField, { kind: "number" }>): string {
  if (field.min !== undefined && field.max !== undefined) return `Enter a number from ${field.min} to ${field.max}.`;
  if (field.min !== undefined) return `Enter a number of at least ${field.min}.`;
  if (field.max !== undefined) return `Enter a number of at most ${field.max}.`;
  return "Enter a number.";
}

/** The review skill picker's discovery (built-in, user and project skills), for an automation's skill field. */
function SkillField({
  projectId,
  value,
  label,
  builtinLabel,
  onSave,
}: {
  projectId: string | null;
  value: unknown;
  label: string;
  builtinLabel: string | undefined;
  onSave: (next: unknown) => boolean;
}) {
  const discovered = useSkills(projectId).data ?? [];
  // The board's skill can't come from one project's folder, as with the review skill.
  const skills = projectId ? discovered : discovered.filter((s) => s.source === "global");
  const parsed = ReviewSkillRef.safeParse(value);
  const current = parsed.success ? parsed.data : { source: "builtin" as const };
  return (
    <ReviewSkillSelect
      ariaLabel={label}
      className={SETTINGS_TEXT_WIDTH}
      options={skillOptions(skills, current, builtinLabel ? { builtinLabel } : {})}
      value={current}
      onChange={(skill) => {
        if (skill) onSave(skill);
      }}
    />
  );
}
