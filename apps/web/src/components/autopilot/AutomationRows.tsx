import {
  AUTOPILOT_ORCHESTRATE,
  ReviewSkillRef,
  type AutopilotConfig,
  type AutopilotAutomation,
  type AutopilotField,
  type AutopilotScopeEntry,
} from "@repo/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { skillOptions } from "~/components/review/review.logic";
import { ReviewSkillSelect } from "~/components/settings/ReviewSettingsSection";
import {
  FoldedSettingsSection,
  SETTINGS_TEXT_WIDTH,
  SettingResetButton,
  SettingsGroup,
  SettingsNote,
  SettingsRow,
  UnitInput,
} from "~/components/settings/settingsLayout";
import { cn } from "~/lib/utils";
import { BlockedWarning } from "./InputsAndSlots";
import { useSetAutopilotScope } from "~/state/mutations";
import { useAutopilotOverview, useAutopilotScope, useSkills } from "~/state/queries";
import { toastManager } from "~/components/ui/toast";
import {
  BOARD_MODES,
  boardModeToSave,
  boardSummary,
  boardSwitchValue,
  entryFor,
  fieldText,
  inheritLabel,
  isClockTime,
  parentEntry,
  parseNumberField,
  withConfigValue,
} from "./autopilot.logic";
import { ModeSwitch } from "./ModeSwitch";
import { TimeInput } from "./TimeInput";

/** Sets or clears one key of a scope's config, built from the latest saved config (see useSetAutopilotScope). */
export type ConfigUpdate = (update: (current: AutopilotConfig) => AutopilotConfig) => void;

export interface AutomationItem {
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
export function useScopeAutomations(projectId: string | null) {
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
 * One row per automation at a scope: its Inherit / On / Off switch (On / Off at the board), and a form for its config
 * generated from the automation's field descriptors. `projectId` null is the board. Config set here applies at this
 * scope only; a key left alone inherits (from the board, for a project; from the automation's default, for the board).
 */
export function AutomationRows({ projectId }: { projectId: string | null }) {
  const { message, items, pending = false, rejected = 0 } = useScopeAutomations(projectId);
  if (message) return <SettingsNote>{message}</SettingsNote>;
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
 * On / Off switch and what it is set to; opening it shows what it does and its config.
 */
export function AutomationSections() {
  const { message, items, pending = false, rejected = 0 } = useScopeAutomations(null);
  if (message) {
    return (
      <SettingsGroup>
        <SettingsNote>{message}</SettingsNote>
      </SettingsGroup>
    );
  }
  return (
    <div className="space-y-2">
      {items
        // Orchestrate has an area of its own above this list (OrchestrateSettings).
        .filter(({ automation }) => automation.key !== AUTOPILOT_ORCHESTRATE)
        .map(({ automation, entry, onMode, onConfig }) => (
          <FoldedSettingsSection
            key={automation.key}
            id={`autopilot.engine.automation-${automation.key}`}
            title={automation.title}
            summary={boardSummary(entry.mode)}
            control={
              <ModeSwitch
                label={`${automation.title} for the board`}
                modes={BOARD_MODES}
                value={boardSwitchValue(entry.mode)}
                disabled={pending}
                blocked={automation.blocked}
                onChange={(mode) => onMode(boardModeToSave(mode))}
              />
            }
          >
            <p className="px-3 py-3 text-xs leading-normal text-muted-foreground/80 sm:px-4">
              {automation.description}
            </p>
            {automation.blocked ? (
              <div className="px-3 pb-3 sm:px-4">
                <BlockedWarning reason={automation.blocked} />
              </div>
            ) : null}
            {automation.fields.map((field) => (
              <AutomationField
                key={field.key}
                automation={automation}
                field={field}
                entry={entry}
                projectId={null}
                rejected={rejected}
                onConfig={onConfig}
              />
            ))}
          </FoldedSettingsSection>
        ))}
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
  const board = projectId === null;
  return (
    <SettingsRow
      title={automation.title}
      description={automation.description}
      status={
        board
          ? boardSummary(entry.mode)
          : entry.mode === "inherit"
            ? inheritLabel(inherited)
            : `Set to ${entry.mode} for ${where}`
      }
      control={
        <ModeSwitch
          label={`${automation.title} for ${where}`}
          modes={board ? BOARD_MODES : undefined}
          value={board ? boardSwitchValue(entry.mode) : entry.mode}
          disabled={pending}
          blocked={automation.blocked}
          onChange={board ? (mode) => onMode(boardModeToSave(mode)) : onMode}
        />
      }
    >
      {automation.blocked ? (
        <div className="mt-2">
          <BlockedWarning reason={automation.blocked} />
        </div>
      ) : null}
      {automation.fields.length ? (
        <Collapsible open={open} onOpenChange={setOpen} className="mt-1">
          <CollapsibleTrigger className="-ms-1 inline-flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-90")}
            />
            Settings
          </CollapsibleTrigger>
          <CollapsiblePanel>
            {/* Edge to edge in the row, so the field rows inside line up with every other row of the card. */}
            <div className="-mx-3 -mb-3 mt-3 border-t border-border/50 sm:-mx-4 [&>*+*]:border-t [&>*+*]:border-border/50">
              {automation.fields.map((field) => (
                <AutomationField
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
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </SettingsRow>
  );
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
      options={skillOptions(skills, current, builtinLabel ? { builtinLabel } : {})}
      value={current}
      onChange={(skill) => {
        if (skill) onSave(skill);
      }}
    />
  );
}
