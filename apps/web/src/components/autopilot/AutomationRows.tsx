import {
  AUTOPILOT_ORCHESTRATE,
  ReviewSkillRef,
  type AutopilotConfig,
  type AutopilotAutomation,
  type AutopilotField,
  type AutopilotScopeEntry,
} from "@repo/contracts";
import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { skillOptions } from "~/components/review/review.logic";
import { ReviewSkillSelect } from "~/components/settings/ReviewSettingsSection";
import { FoldedSettingsSection, SettingsGroup, SettingsRow } from "~/components/settings/settingsLayout";
import { cn } from "~/lib/utils";
import { BlockedWarning } from "./InputsAndSlots";
import { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotScope, useBoard, useSkills } from "~/state/queries";
import { toastManager } from "~/components/ui/toast";
import {
  entryFor,
  fieldText,
  inheritLabel,
  isClockTime,
  parentEntry,
  parseNumberField,
  withConfigValue,
} from "./autopilot.logic";
import { ModeSwitch } from "./ModeSwitch";
import { ScheduledRuns } from "./ScheduledRuns";
import { TimeInput } from "./TimeInput";

/** Sets or clears one key of a scope's config, built from the latest saved config (see useSetAutopilotScope). */
type ConfigUpdate = (update: (current: AutopilotConfig) => AutopilotConfig) => void;

interface AutomationItem {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  inherited: AutopilotScopeEntry | null;
  onMode: (mode: AutopilotScopeEntry["mode"]) => void;
  onConfig: ConfigUpdate;
}

/**
 * Every automation at a scope, with its entry there and the scope's setters, or the message to show instead while
 * loading, on an error or with no automations. `projectId` null is the board.
 */
function useScopeAutomations(projectId: string | null) {
  const overview = useAutopilotOverview();
  const scope = useAutopilotScope(projectId);
  const board = useAutopilotScope(null, projectId !== null);
  // Bumped when the server rejects a save, so the form controls drop the text it refused.
  const [rejected, setRejected] = useState(0);
  const set = useSetAutopilotScope(projectId, () => setRejected((n) => n + 1));
  const automations = overview.data?.automations;
  const failed = overview.error ?? scope.error ?? board.error;
  // The forms send a scope's whole config, so they wait for the real entries rather than editing stand-ins.
  const loaded = automations && scope.data && (projectId === null || board.data);
  if (!loaded) return { message: failed ? failed.message : "Loading automations...", items: [] };
  if (automations.length === 0) return { message: "No automations are installed yet.", items: [] };
  const items = automations.map((automation): AutomationItem => ({
    automation,
    entry: entryFor(scope.data, automation),
    inherited: projectId ? parentEntry(board.data, automation.key) : null,
    onMode: (mode) => set.mutate({ automation: automation.key, mode }),
    onConfig: (config) => set.mutate({ automation: automation.key, config }),
  }));
  return { message: null, items, pending: set.isPending, rejected };
}

/**
 * One row per automation at a scope: its Inherit / On / Off switch, and a form for its config generated from the
 * automation's field descriptors. `projectId` null is the board. Config set here applies at this scope only; a key
 * left alone inherits (from the board, for a project; from the automation's default, for the board).
 */
export function AutomationRows({ projectId }: { projectId: string | null }) {
  const { message, items, pending = false, rejected = 0 } = useScopeAutomations(projectId);
  if (message) return <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{message}</p>;
  return (
    <>
      {items.map((item) => (
        <AutomationRow
          key={item.automation.key}
          {...item}
          projectId={projectId}
          pending={pending}
          rejected={rejected}
        />
      ))}
    </>
  );
}

/**
 * The board's automations as folded sections, for the Autopilot settings page: the header has the automation's
 * Inherit / On / Off switch and what it resolves to; opening it shows what it does and its config.
 */
export function AutomationSections() {
  const { message, items, pending = false, rejected = 0 } = useScopeAutomations(null);
  if (message) {
    return (
      <SettingsGroup>
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">{message}</p>
      </SettingsGroup>
    );
  }
  return (
    <div className="space-y-2">
      {items.map(({ automation, entry, onMode, onConfig }) => (
        <FoldedSettingsSection
          key={automation.key}
          id={`autopilot.engine.automation-${automation.key}`}
          title={automation.title}
          summary={entry.mode === "inherit" ? inheritLabel(null) : `Set to ${entry.mode} for the board`}
          control={
            <ModeSwitch
              label={`${automation.title} for the board`}
              value={entry.mode}
              disabled={pending}
              blocked={automation.blocked}
              onChange={onMode}
            />
          }
        >
          <p className="px-3 py-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">{automation.description}</p>
          {automation.blocked ? (
            <div className="px-3 pb-3 sm:px-4">
              <BlockedWarning reason={automation.blocked} />
            </div>
          ) : null}
          {automation.fields.map((field) => (
            <div key={field.key} className="@container/settings-row px-3 sm:px-4">
              <FieldRow
                automation={automation}
                field={field}
                entry={entry}
                projectId={null}
                rejected={rejected}
                onConfig={onConfig}
              />
            </div>
          ))}
          {automation.key === AUTOPILOT_ORCHESTRATE ? <OrchestrateRuns /> : null}
        </FoldedSettingsSection>
      ))}
    </div>
  );
}

/** Orchestrate's latest runs per project: what each did and the handover it left, since its runs have no task. */
function OrchestrateRuns() {
  const projects = useBoard().data?.projects.filter((p) => p.archivedAt === null) ?? [];
  return (
    <div className="flex flex-col gap-1.5 px-3 py-3 sm:px-4">
      <p className="text-xs font-medium">Recent runs</p>
      <p className="text-2xs text-muted-foreground/80">
        What each run said it did, and the handover it left for the next run in that project.
      </p>
      <ScheduledRuns automation={AUTOPILOT_ORCHESTRATE} projects={projects} />
    </div>
  );
}

function AutomationRow({
  automation,
  entry,
  inherited,
  projectId,
  pending,
  rejected,
  onMode,
  onConfig,
}: {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  inherited: AutopilotScopeEntry | null;
  projectId: string | null;
  pending: boolean;
  rejected: number;
  onMode: (mode: AutopilotScopeEntry["mode"]) => void;
  onConfig: ConfigUpdate;
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
          blocked={automation.blocked}
          onChange={onMode}
        />
      }
    >
      {automation.blocked ? (
        <div className="mt-2">
          <BlockedWarning reason={automation.blocked} />
        </div>
      ) : null}
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
                  rejected={rejected}
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
  return (
    <div className="flex flex-col gap-2 py-2.5 @min-[32rem]/settings-row:flex-row @min-[32rem]/settings-row:items-center @min-[32rem]/settings-row:justify-between @min-[32rem]/settings-row:gap-6">
      <div className="min-w-0">
        <p className="text-xs font-medium">{field.label}</p>
        {field.help ? <p className="max-w-md text-2xs text-muted-foreground/80">{field.help}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <FieldControl
          key={rejected}
          field={field}
          value={value}
          projectId={projectId}
          onSave={save}
          label={field.label}
        />
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
            className="sm:w-80"
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
          className="sm:w-56"
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
    case "time":
      return (
        <TimeInput
          label={label}
          // Anything that isn't HH:MM shows blank, which a time input accepts.
          value={typeof value === "string" && isClockTime(value) ? value : ""}
          onSave={onSave}
        />
      );
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
          } else if (next !== (typeof value === "number" ? value : undefined) && !onSave(next)) {
            input.value = fieldText(value);
          }
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
      options={skillOptions(skills, current, builtinLabel ? { builtinLabel } : {})}
      value={current}
      onChange={(skill) => {
        if (skill) onSave(skill);
      }}
    />
  );
}
