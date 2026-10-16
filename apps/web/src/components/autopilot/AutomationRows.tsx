import {
  ReviewSkillRef,
  type AutopilotAutomation,
  type AutopilotField,
  type AutopilotScopeEntry,
} from "@repo/contracts";
import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { skillOptions } from "~/components/review/review.logic";
import { ReviewSkillSelect } from "~/components/settings/ReviewSettingsSection";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { cn } from "~/lib/utils";
import { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotScope, useSkills } from "~/state/queries";
import { toastManager } from "~/components/ui/toast";
import { entryFor, fieldText, inheritLabel, parentEntry, parseNumberField, withConfigValue } from "./autopilot.logic";
import { ModeSwitch } from "./ModeSwitch";

/**
 * One row per automation at a scope: its Inherit / On / Off switch, and a form for its config generated from the
 * automation's field descriptors. `projectId` null is the board. Config set here applies at this scope only; a key
 * left alone inherits (from the board, for a project; from the automation's default, for the board).
 */
export function AutomationRows({ projectId }: { projectId: string | null }) {
  const overview = useAutopilotOverview();
  const scope = useAutopilotScope(projectId);
  const board = useAutopilotScope(null, projectId !== null);
  const set = useSetAutopilotScope(projectId);
  const automations = overview.data?.automations;
  if (!automations) {
    return <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">Loading automations...</p>;
  }
  if (automations.length === 0) {
    return <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">No automations are installed yet.</p>;
  }
  return (
    <>
      {automations.map((automation) => {
        const entry = entryFor(scope.data, automation);
        return (
          <AutomationRow
            key={automation.key}
            automation={automation}
            entry={entry}
            inherited={projectId ? parentEntry(board.data, automation.key) : null}
            projectId={projectId}
            pending={set.isPending}
            onMode={(mode) => set.mutate({ automation: automation.key, mode })}
            onConfig={(config) => set.mutate({ automation: automation.key, config })}
          />
        );
      })}
    </>
  );
}

function AutomationRow({
  automation,
  entry,
  inherited,
  projectId,
  pending,
  onMode,
  onConfig,
}: {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  inherited: AutopilotScopeEntry | null;
  projectId: string | null;
  pending: boolean;
  onMode: (mode: AutopilotScopeEntry["mode"]) => void;
  onConfig: (config: AutopilotScopeEntry["config"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const where = projectId ? "this project" : "the board";
  return (
    <SettingsRow
      title={automation.title}
      description={automation.description}
      status={entry.mode === "inherit" ? inheritLabel(inherited) : `Set to ${entry.mode} for ${where}`}
      control={
        <ModeSwitch
          label={`${automation.title} for ${where}`}
          value={entry.mode}
          disabled={pending}
          onChange={onMode}
        />
      }
    >
      {automation.fields.length ? (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={open}
            className="-ms-1 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setOpen(!open)}
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
            Settings
          </button>
          {open ? (
            <div className="mt-1 flex flex-col divide-y divide-border/40 rounded-lg border border-border/50 bg-background/30 px-3">
              {automation.fields.map((field) => (
                <FieldRow
                  key={field.key}
                  automation={automation}
                  field={field}
                  entry={entry}
                  projectId={projectId}
                  onConfig={onConfig}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsRow>
  );
}

function FieldRow({
  automation,
  field,
  entry,
  projectId,
  onConfig,
}: {
  automation: AutopilotAutomation;
  field: AutopilotField;
  entry: AutopilotScopeEntry;
  projectId: string | null;
  onConfig: (config: AutopilotScopeEntry["config"]) => void;
}) {
  const overridden = field.key in entry.config;
  const value = field.key in entry.effectiveConfig ? entry.effectiveConfig[field.key] : automation.defaults[field.key];
  const save = (next: unknown) => onConfig(withConfigValue(entry.config, field.key, next));
  return (
    <div className="flex flex-col gap-2 py-2.5 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:justify-between @min-[32rem]/settings-row:gap-6">
      <div className="min-w-0">
        <p className="text-xs font-medium">{field.label}</p>
        {field.help ? <p className="max-w-md text-2xs text-muted-foreground/80">{field.help}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <FieldControl field={field} value={value} projectId={projectId} onSave={save} label={field.label} />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Reset ${field.label}`}
                className={cn(!overridden && "invisible")}
                tabIndex={overridden ? 0 : -1}
                onClick={() => save(undefined)}
              />
            }
          >
            <RotateCcwIcon />
          </TooltipTrigger>
          <TooltipPopup>{projectId ? "Use the board's value" : "Use the default"}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
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
  onSave: (next: unknown) => void;
  label: string;
}) {
  switch (field.kind) {
    case "boolean":
      return <Switch aria-label={label} checked={value === true} onCheckedChange={(checked) => onSave(checked)} />;
    case "number":
      return <NumberField key={fieldText(value)} field={field} value={value} onSave={onSave} />;
    case "text":
      return (
        <Input
          key={fieldText(value)}
          aria-label={label}
          size="sm"
          className="sm:w-56"
          placeholder={field.placeholder}
          defaultValue={fieldText(value)}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            if (next !== fieldText(value)) onSave(next === "" ? undefined : next);
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
          <SelectTrigger size="sm" className="sm:w-44" aria-label={label}>
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
    case "skill":
      return <SkillField projectId={projectId} value={value} label={label} onSave={onSave} />;
  }
}

/** A number saved on blur or Enter. Empty clears the key, so it inherits again; a value out of range is put back. */
function NumberField({
  field,
  value,
  onSave,
}: {
  field: Extract<AutopilotField, { kind: "number" }>;
  value: unknown;
  onSave: (next: unknown) => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        aria-label={field.label}
        size="sm"
        font="mono"
        inputMode="decimal"
        className="w-24"
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
          } else if (next !== (typeof value === "number" ? value : undefined)) onSave(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {field.unit ? <span className="text-xs text-muted-foreground">{field.unit}</span> : null}
    </span>
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
  onSave,
}: {
  projectId: string | null;
  value: unknown;
  label: string;
  onSave: (next: unknown) => void;
}) {
  const discovered = useSkills(projectId).data ?? [];
  // The board's skill can't come from one project's folder, as with the review skill.
  const skills = projectId ? discovered : discovered.filter((s) => s.source === "global");
  const parsed = ReviewSkillRef.safeParse(value);
  const current = parsed.success ? parsed.data : { source: "builtin" as const };
  return (
    <ReviewSkillSelect
      ariaLabel={label}
      options={skillOptions(skills, current)}
      value={current}
      onChange={(skill) => {
        if (skill) onSave(skill);
      }}
    />
  );
}
