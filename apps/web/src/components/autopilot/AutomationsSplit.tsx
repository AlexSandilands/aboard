// Settings → Autopilot → Automations: every automation in one list down the left, grouped, each with its switch, and
// the picked one's detail on the right (the Providers page's split card). Built-ins switched off stay in the list,
// dimmed; custom automations are listed once, under Yours.
import {
  AUTOPILOT_DIGEST,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_MERGE_EPIC_PRS,
  AUTOPILOT_IMPROVE,
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_RECURRING,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_START_PLANNED,
  automationSentence,
  createAutomationPrompt,
  customAutomationId,
  isOnMode,
  boardState,
  OPERATIONS,
  splitFieldsByTier,
  whereEverywhere,
  whereOffEverywhere,
  whereOwnOn,
  type AutopilotAgentDefaults,
  type AutopilotAutomation,
  type AutopilotMode,
  type AutopilotField,
  type AutopilotScopeEntry,
  type CustomAutomation,
  type Project,
  type WhereState,
} from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArchiveIcon,
  BotIcon,
  ChevronRightIcon,
  EyeIcon,
  GitMergeIcon,
  type LucideIcon,
  NewspaperIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  ScanSearchIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Undo2Icon,
  WorkflowIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { SettingsLink, SettingsNote, SettingsRow, StatusDot } from "~/components/settings/settingsLayout";
import {
  DetailBody,
  DetailHeader,
  DetailSection,
  SplitBack,
  SplitCard,
  SplitList,
  SplitListAction,
  SplitListGroup,
  SplitListItem,
} from "~/components/settings/agents/SplitCard";
import { FROM_SETTINGS_LIST } from "~/components/settings/settingsNavigation";
import { AskAgentMenu } from "~/components/handoff/HandoffActions";
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { downloadText } from "~/lib/download";
import { cn } from "~/lib/utils";
import { inheritDetail } from "~/components/models/choicePicker.logic";
import { operationTarget } from "~/components/models/operations.logic";
import { useDeleteCustomAutomation, useExportCustomAutomation } from "~/state/customAutomations";
import { useAutopilotOverview } from "~/state/queries";
import { useAutopilotScope, useSettings } from "~/state/queries";
import { useSetAutopilotScope } from "~/state/mutations";
import { useRowScope } from "~/components/settings/SettingsScope";
import { AutomationField, type AutomationItem, type ConfigUpdate } from "./AutomationRows";
import {
  advancedChangedCount,
  advancedFieldNames,
  fieldChanged,
  fieldDefault,
  agentFieldsTitle,
  agentSummary,
  groupAutomations,
  isOffEverywhere,
  onInProjectsText,
  rowSubline,
  selectedAutomation,
  splitAgentFields,
  statusLine,
  switchState,
  type AutomationReach,
  type RowSubline,
  type LastRun,
} from "./automationList.logic";
import {
  BOARD_MODES,
  boardModeToSave,
  boardSwitchValue,
  modeDescription,
  previewHint,
  restoreMode,
  withConfigValue,
} from "./autopilot.logic";
import { AddAutomationDialog } from "./AddAutomationDialog";
import { AskToChange } from "./AskAgentButtons";
import type { QuickSetupState } from "./QuickSetup";
import { bundleFilename } from "./customAutomationImport.logic";
import { BlockedWarning, NeedsVariablesWarning } from "./InputsAndSlots";
import { HintNotice, PausedRows, WeekSection } from "./HealthSections";
import { hintsFor, pausedText, pausesFor } from "./health.logic";
import { MergeTargets } from "./MergeTargets";
import { ModeSwitch } from "./ModeSwitch";
import { RecurringRulesByProject } from "~/components/recurring/RecurringSection";
import { RunHistoryLink } from "./RunHistoryLink";
import { useWhere } from "./useWhere";
import { ownSettingsLabel, scopeState, scopeToggle } from "./where.logic";
import { WhereItRuns } from "./WhereItRuns";
import { useScopeParam } from "~/components/settings/SettingsScope";
import { scopeSearch } from "~/components/settings/settingsScope.logic";

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  [AUTOPILOT_START_PLANNED]: PlayIcon,
  [AUTOPILOT_ORCHESTRATE]: WorkflowIcon,
  [AUTOPILOT_IMPROVE]: SparklesIcon,
  [AUTOPILOT_REVIEW_PRS]: ScanSearchIcon,
  [AUTOPILOT_FIX_PRS]: WrenchIcon,
  [AUTOPILOT_MERGE_EPIC_PRS]: GitMergeIcon,
  [AUTOPILOT_RECURRING]: RepeatIcon,
  auto_archive: ArchiveIcon,
  [AUTOPILOT_DIGEST]: NewspaperIcon,
};

function AutomationIcon({ automation, className }: { automation: AutopilotAutomation; className?: string }) {
  const Icon = BUILTIN_ICONS[automation.key] ?? (automation.needsAgent ? BotIcon : SquareTerminalIcon);
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** One automation with what the list and detail show of it. */
export interface ListedAutomation extends AutomationItem {
  reach: AutomationReach;
  lastRun: LastRun | undefined;
  /** Its "would …" runs over the last 7 days. */
  previewRuns: number;
  custom: CustomAutomation | null;
}

/**
 * The board's mode from a list row's switch, the detail header's Switch on/off and its Mode row. Turning it on from
 * off is Everywhere, so the project rows Only in… left are dropped with it and a later off really is off; any other
 * choice is the board's own row (Off saves Inherit, as before).
 *
 * Switching off (`switchOff`) asks first when projects or epics set their own On, since switching off only the board
 * leaves them running: Off everywhere clears them, Board only keeps them. `dialog` is that question, to render.
 */
function useBoardMode(item: ListedAutomation): {
  set: (mode: AutopilotMode) => void;
  ready: boolean;
  /** How many projects and epics set their own On or Preview; 0 while loading. */
  ownOn: number;
  offEverywhere: () => void;
  switchOff: () => void;
  dialog: React.ReactNode;
} {
  const { input, apply } = useWhere(item.automation);
  const [asking, setAsking] = useState(false);
  const own = input ? whereOwnOn(input) : null;
  const ownOn = own ? own.projects.length + own.epics.length : 0;
  const set = (mode: AutopilotMode) => {
    if ((mode === "on" || mode === "preview") && input && boardState(input.board) === "off") {
      const writes = whereEverywhere(input, mode);
      if (writes.length > 0) apply.mutate(writes);
    } else item.onMode(boardModeToSave(mode));
  };
  const offEverywhere = () => {
    if (!input) return;
    const writes = whereOffEverywhere(input);
    if (writes.length > 0) apply.mutate(writes);
  };
  const boardOn = input ? boardState(input.board) !== "off" : false;
  return {
    // Turning on from off needs the project and epic rows to drop, so it waits for them rather than saving only the board.
    ready: input !== null,
    set,
    ownOn,
    offEverywhere,
    // Until the scopes load it can't tell whether projects set their own On, so it doesn't guess (the controls wait too).
    switchOff: () => {
      if (!input) return;
      if (ownOn > 0) setAsking(true);
      else set("off");
    },
    dialog: (
      <SwitchOffDialog
        open={asking}
        onOpenChange={setAsking}
        title={item.automation.title}
        projects={own?.projects.map((p) => p.title) ?? []}
        epics={own?.epics.length ?? 0}
        boardOn={boardOn}
        onEverywhere={offEverywhere}
        onBoardOnly={() => set("off")}
      />
    ),
  };
}

/**
 * Asked when switching off an automation that projects or epics set On themselves: Off everywhere clears their own
 * On; Board only switches off the board's and leaves them running. A board that is already off has nothing to switch
 * off on its own, so only Off everywhere is offered.
 */
function SwitchOffDialog({
  open,
  onOpenChange,
  title,
  projects,
  epics,
  boardOn,
  onEverywhere,
  onBoardOnly,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  projects: string[];
  epics: number;
  boardOn: boolean;
  onEverywhere: () => void;
  onBoardOnly: () => void;
}) {
  const where = [
    ...(projects.length > 0 ? [projects.length <= 3 ? projects.join(", ") : `${projects.length} projects`] : []),
    ...(epics > 0 ? [epics === 1 ? "1 epic" : `${epics} epics`] : []),
  ].join(" and ");
  const done = (fn: () => void) => () => {
    fn();
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup showCloseButton={false} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Switch off {title}?</DialogTitle>
          <DialogDescription>
            {where} {projects.length + epics === 1 ? "sets its" : "set their"} own On, which beats the board.{" "}
            {boardOn
              ? "Off everywhere clears that too; Board only switches off the board's and leaves them running."
              : "Off everywhere clears that, so it runs nowhere."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          {boardOn ? (
            <Button variant="outline" onClick={done(onBoardOnly)}>
              Board only
            </Button>
          ) : null}
          <Button variant="destructive" onClick={done(onEverywhere)}>
            Off everywhere
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A custom automation whose agent action starts from a check script, which still runs for real in Preview. */
export const hasCheckScript = (custom: CustomAutomation | null): boolean =>
  custom?.action.kind === "agent" && custom.action.check !== null;

/** The list and the picked automation's detail. The automation in `?automation=` is picked; with none, the first. */
export function AutomationsSplit({
  items,
  pending,
  rejected,
  quickSetup,
}: {
  items: ListedAutomation[];
  /** What Quick setup in the Add dialog reads. */
  quickSetup: QuickSetupState;
  pending: boolean;
  rejected: number;
}) {
  const navigate = useNavigate();
  const scope = scopeSearch(useScopeParam());
  const requested = useSearch({ strict: false, select: (search) => search.automation });
  const [adding, setAdding] = useState(false);
  // With a project chosen in the scope sentence, each switch is that project's.
  const { project } = useRowScope();
  const autoPaused = useAutopilotOverview().data?.autoPaused ?? [];
  const groups = groupAutomations(items);
  const ordered = groups.flatMap((g) => g.items);
  const selectedKey = selectedAutomation(
    ordered.map((i) => i.automation.key),
    requested,
  );
  const selected = ordered.find((i) => i.automation.key === selectedKey) ?? null;
  const select = (automation: string | undefined) =>
    void navigate({
      to: "/settings/$group",
      params: { group: "autopilot" },
      search: { ...scope, ...(automation ? { automation } : {}) },
      replace: true,
    });

  return (
    <>
      <SplitCard
        detailOpen={requested !== undefined && selected !== null}
        list={
          <SplitList label="Automations">
            {groups.map((group) => (
              <SplitListGroup key={group.group} label={group.label}>
                {group.items.map((item) =>
                  project ? (
                    <ProjectListRow
                      key={item.automation.key}
                      item={item}
                      project={project}
                      pending={pending}
                      selected={item.automation.key === selectedKey}
                      onSelect={() => select(item.automation.key)}
                    />
                  ) : (
                    <ListRow
                      key={item.automation.key}
                      item={item}
                      paused={pausedText(pausesFor(autoPaused, item.automation.key))}
                      pending={pending}
                      selected={item.automation.key === selectedKey}
                      onSelect={() => select(item.automation.key)}
                    />
                  ),
                )}
              </SplitListGroup>
            ))}
            <div className="flex items-center gap-1 pe-2 sm:pe-3">
              <div className="min-w-0 flex-1">
                <SplitListAction
                  icon={<PlusIcon className="size-4 shrink-0" />}
                  label="Add automation"
                  onClick={() => setAdding(true)}
                />
              </div>
              <AskAgentMenu
                label="Ask an agent to write an automation"
                threadLabel="Write an automation"
                prompt={() => createAutomationPrompt({ boardUrl: window.location.origin })}
              />
            </div>
          </SplitList>
        }
      >
        {selected ? (
          <AutomationDetail
            key={selected.automation.key}
            item={selected}
            pending={pending}
            rejected={rejected}
            onBack={() => select(undefined)}
          />
        ) : (
          <SettingsNote>No automations are installed yet.</SettingsNote>
        )}
      </SplitCard>
      <AddAutomationDialog open={adding} onOpenChange={setAdding} quickSetup={quickSetup} />
    </>
  );
}

function ListRow({
  item,
  paused,
  pending,
  selected,
  onSelect,
}: {
  item: ListedAutomation;
  /** "Paused in storefront" when it paused itself somewhere after failing. */
  paused: string | null;
  pending: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { automation, entry, reach, lastRun } = item;
  const board = useBoardMode(item);
  const on = isOnMode(entry.mode);
  const off = !automation.alwaysOn && isOffEverywhere(reach);
  const state = switchState(reach);
  return (
    <>
      <SplitListItem
        id={`autopilot.automations.${automation.key}`}
        icon={<AutomationIcon automation={automation} />}
        title={automation.title}
        subtitle={
          <Subline
            line={rowSubline(reach, lastRun, {
              paused: off ? null : paused,
              preview: entry.mode === "preview",
              switchless: automation.alwaysOn,
            })}
          />
        }
        dimmed={off}
        selected={selected}
        onSelect={onSelect}
        // Recurring tasks has no switch: each of its rules has its own, in the detail.
        trailing={
          automation.alwaysOn ? null : (
            <Switch
              size="sm"
              aria-label={
                state === "mixed"
                  ? `${automation.title}: off for the board, ${onInProjectsText(reach)}`
                  : `${automation.title} on for the board`
              }
              checked={on}
              mixed={state === "mixed"}
              // On somewhere, so the track takes a tint of On rather than the plain Off of a mixed selection.
              className="data-[mixed]:bg-primary/45"
              // Either way it waits for the scopes: switching on drops Only in…'s rows, switching off asks about them.
              disabled={pending || !board.ready || (!on && state !== "mixed" && Boolean(automation.blocked))}
              title={!on && state !== "mixed" && automation.blocked ? automation.blocked : undefined}
              // Back on in the mode it was last on in, or Preview for one that has never run. A mixed switch is on
              // somewhere, so a click switches it off.
              onCheckedChange={(next) =>
                next && state !== "mixed" ? board.set(restoreMode(entry, lastRun !== undefined)) : board.switchOff()
              }
            />
          )
        }
      />
      {board.dialog}
    </>
  );
}

/** A row's subline: the state its switch can't show as a coloured word, then where it runs and its last run. */
function Subline({ line }: { line: RowSubline }) {
  return (
    <>
      {line.word ? (
        <span
          className={cn(
            "font-medium",
            line.word.tone === "danger" ? "text-destructive-foreground" : "text-warning-foreground",
          )}
        >
          {line.word.text}
        </span>
      ) : null}
      {line.word && line.text ? line.sep : null}
      {line.text}
    </>
  );
}

/**
 * The picked automation: its state and actions, the sentence saying what it does, where it runs, its essential
 * settings, then a closed Advanced section for the rest (with a dot when anything there isn't the default).
 */
function AutomationDetail({
  item,
  pending,
  rejected,
  onBack,
}: {
  item: ListedAutomation;
  pending: boolean;
  rejected: number;
  onBack: () => void;
}) {
  const { automation, entry, reach, custom, lastRun, previewRuns, onConfig } = item;
  const board = useBoardMode(item);
  const { project } = useRowScope();
  const navigate = useNavigate();
  const scope = scopeSearch(useScopeParam());
  // A field drawn in another's row (`inRowOf`), or set in the Where it runs table, gets no row of its own.
  const { essential, advanced } = splitFieldsByTier(automation.fields.filter((f) => !f.inRowOf && !f.inWhereTable));
  const overview = useAutopilotOverview().data;
  const agentDefaults = overview?.engine.agentDefaults ?? {};
  const hints = hintsFor(overview?.hints ?? [], automation.key);
  const pauses = pausesFor(overview?.autoPaused ?? [], automation.key);
  const agent = splitAgentFields(advanced);
  const on = isOnMode(entry.mode);
  const preview = entry.mode === "preview";
  const switchless = automation.alwaysOn;
  const off = !switchless && isOffEverywhere(reach);
  const mixed = !switchless && switchState(reach) === "mixed";
  const checkScript = hasCheckScript(custom);
  const editCustom = (id: string) =>
    void navigate({
      to: "/settings/autopilot/custom/$customId",
      params: { customId: id },
      search: scope,
      state: FROM_SETTINGS_LIST,
    });
  const field = (f: (typeof automation.fields)[number]) => (
    <AutomationField
      key={f.key}
      automation={automation}
      field={f}
      entry={entry}
      projectId={null}
      rejected={rejected}
      onConfig={onConfig}
    />
  );

  return (
    <DetailBody>
      <SplitBack label="All automations" onBack={onBack} />
      <DetailHeader
        icon={<AutomationIcon automation={automation} className="size-6" />}
        title={automation.title}
        subtitle={
          <span className="flex items-center gap-1.5">
            {switchless ? null : (
              <StatusDot
                tone={off ? "muted" : preview && !mixed ? "warning" : "success"}
                label={off ? "Off" : mixed ? "On in some projects" : preview ? "Preview" : "On"}
              />
            )}
            <span className="truncate">{switchless ? "Each rule has its own switch" : statusLine(reach, preview)}</span>
            {custom ? (
              <Badge variant="outline" size="sm">
                Custom
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <>
            {/* In project scope the switch is the project's, in its own section below. */}
            {switchless || project ? null : (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending || !board.ready || (!on && !mixed && Boolean(automation.blocked))}
                // A mixed automation runs somewhere, so this switches it off, as its list switch does.
                onClick={() => (on || mixed ? board.switchOff() : board.set(restoreMode(entry, lastRun !== undefined)))}
              >
                {on || mixed ? "Switch off" : "Switch on"}
              </Button>
            )}
            <AskToChange
              automation={automation}
              custom={custom}
              sentence={automationSentence(automation, entry.effectiveConfig, { custom })}
            />
            {custom ? <CustomActions custom={custom} /> : null}
          </>
        }
      />
      {project && !switchless ? <ProjectHere automation={automation} project={project} pending={pending} /> : null}
      {automation.blocked || automation.needs ? (
        <div className="space-y-2 px-3 sm:px-4">
          {automation.blocked ? <BlockedWarning reason={automation.blocked} /> : null}
          {automation.needs ? (
            <NeedsVariablesWarning needs={automation.needs} custom={customAutomationId(automation.key) !== null} />
          ) : null}
        </div>
      ) : null}
      {hints.length > 0 ? (
        <div className="space-y-2 px-3 sm:px-4">
          {hints.map((hint) => (
            <HintNotice key={hint.id} hint={hint} target={{ onConfig }} />
          ))}
        </div>
      ) : null}
      {preview ? (
        <PreviewNotice
          count={previewRuns}
          automation={automation.key}
          disabled={pending || Boolean(automation.blocked)}
          onTurnOn={() => board.set("on")}
        />
      ) : null}
      <DetailSection title="What it does">
        <div className="flex flex-col gap-3 px-3 py-3 @min-[32rem]/split:flex-row @min-[32rem]/split:items-start sm:px-4">
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
            {automationSentence(automation, entry.effectiveConfig, { custom })}
          </p>
          {/* While it's on, This week links to its runs. */}
          {off ? (
            <div className="shrink-0 self-start">
              <RunHistoryLink automation={automation.key} label="All runs" size="xs" />
            </div>
          ) : null}
        </div>
        {switchless ? null : (
          <SettingsRow
            id={`autopilot.automations.${automation.key}.board`}
            title={
              <>
                Mode <span className="text-muted-foreground">· for the board</span>
              </>
            }
            description={
              !on && mixed ? (
                <>
                  <span className="font-medium text-foreground">Off for the board.</span> {onInProjectsText(reach)},{" "}
                  {reach.projects.length === 1 ? "which sets its own" : "which set their own"}.{" "}
                  <button
                    type="button"
                    className="cursor-pointer text-foreground underline underline-offset-2 hover:text-primary disabled:cursor-not-allowed disabled:opacity-64"
                    disabled={pending || !board.ready}
                    onClick={board.offEverywhere}
                  >
                    Turn off everywhere
                  </button>
                </>
              ) : (
                modeDescription(boardSwitchValue(entry.mode) as "off" | "preview" | "on", automation, checkScript)
              )
            }
            infoLabel="More about Mode"
            info="The board's own setting: a project or epic that sets its own beats it. Off: nothing runs. Preview: each time it would act, a run marked Preview is recorded instead; no agent starts and nothing on the board or on GitHub changes. A custom automation's check script is the exception: it runs for real. New, imported and drafted automations save in Preview."
            control={
              <ModeSwitch
                label={`${automation.title} for the board`}
                modes={BOARD_MODES}
                value={boardSwitchValue(entry.mode)}
                disabled={pending || (!on && !board.ready)}
                blocked={automation.blocked}
                onChange={board.set}
              />
            }
          />
        )}
      </DetailSection>
      {switchless ? <RecurringRulesByProject /> : null}
      {switchless ? null : (
        <WhereItRuns automation={automation} everywhereMode={restoreMode(entry, lastRun !== undefined)} />
      )}
      {automation.key === AUTOPILOT_ORCHESTRATE ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Each lane&apos;s pill also shows Orchestrate&apos;s next check and has Run now.
        </p>
      ) : null}
      {pauses.length > 0 ? (
        <DetailSection title="Paused">
          <PausedRows pauses={pauses} />
        </DetailSection>
      ) : null}
      {off ? null : <WeekSection automation={automation.key} />}
      {automation.key === AUTOPILOT_MERGE_EPIC_PRS ? (
        <MergeTargets automation={automation} entry={entry} rejected={rejected} onConfig={onConfig} />
      ) : essential.length > 0 ? (
        <DetailSection title="Settings">{essential.map(field)}</DetailSection>
      ) : null}
      {custom ? (
        <DetailSection title="Trigger and action">
          <SettingsRow
            title="Edit the automation"
            description="Its trigger, filters, prompt or command, inputs and tool slots."
            control={
              <Button size="xs" variant="outline" onClick={() => editCustom(custom.id)}>
                Edit
              </Button>
            }
          />
        </DetailSection>
      ) : null}
      {advanced.length > 0 ? (
        <AdvancedSection
          changed={advancedChangedCount(automation, entry.config, agentDefaults)}
          fields={advancedFieldNames(advanced)}
        >
          {agent.model?.kind === "model" ? (
            <ModelLine
              automation={automation}
              field={agent.model}
              entry={entry}
              rejected={rejected}
              onConfig={onConfig}
              agentDefaults={agentDefaults}
            />
          ) : null}
          {agent.runner.length > 0 ? (
            <AgentDefaultsLine
              automation={automation}
              fields={agent.runner}
              entry={entry}
              rejected={rejected}
              onConfig={onConfig}
              agentDefaults={agentDefaults}
            />
          ) : null}
          {agent.rest.map((f) => (
            <AutomationField
              key={f.key}
              automation={automation}
              field={f}
              entry={entry}
              projectId={null}
              rejected={rejected}
              onConfig={onConfig}
              defaults={{ value: fieldDefault(automation, f, agentDefaults) }}
            />
          ))}
        </AdvancedSection>
      ) : null}
      {off && !custom ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {automation.title} is off everywhere. Its settings are kept for when you switch it on.
        </p>
      ) : null}
      {board.dialog}
    </DetailBody>
  );
}

type FieldLineProps<F> = {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  rejected: number;
  onConfig: ConfigUpdate;
  /** Limits & safety's agent defaults, what the agent's fields are when not set here. */
  agentDefaults: Partial<AutopilotAgentDefaults>;
} & F;

/**
 * The agent's model as one line: where it comes from (Agents → Operations, for runs of this kind), what that resolves
 * to, and Override. Overriding, or once set here, it is the model picker with a ↶ the whole time, its way back out.
 */
function ModelLine({
  automation,
  field,
  entry,
  rejected,
  onConfig,
  agentDefaults,
}: FieldLineProps<{ field: Extract<AutopilotField, { kind: "model" }> }>) {
  const settings = useSettings().data;
  const [overriding, setOverriding] = useState(false);
  const op = field.operation ?? "customTask";
  const changed = fieldChanged(automation, field, entry.config, agentDefaults);
  if (overriding || changed || !settings) {
    return (
      <AutomationField
        automation={automation}
        field={field}
        entry={entry}
        projectId={null}
        rejected={rejected}
        onConfig={onConfig}
        defaults={{ value: fieldDefault(automation, field, agentDefaults) }}
        alwaysReset
        onReset={() => setOverriding(false)}
      />
    );
  }
  return (
    <SettingsRow
      id={`autopilot.automations.${automation.key}.model`}
      title="Model"
      description={
        <>
          From <SettingsLink to={operationTarget(op)}>Agents → Operations</SettingsLink> unless set here.
        </>
      }
      infoLabel="More about Model"
      info={`${OPERATIONS[op].label}: the board's model for this kind of run, else the task's own (a custom model one of its labels picks, else its suggested tier).`}
      status={`Now: ${inheritDetail(op, { needs: field.needs }, settings)}`}
      control={
        <Button size="xs" variant="outline" onClick={() => setOverriding(true)}>
          Override
        </Button>
      }
    />
  );
}

/**
 * Runner, budget, timeout and T3 access as one line: the board's defaults from Limits & safety, or how many are set
 * here, with what they come to now. Override opens a row per field; a field's ↶ shows only while it differs from its
 * default and resets that field alone, and the line's ↶ Reset puts them all back and closes it.
 */
function AgentDefaultsLine({
  automation,
  fields,
  entry,
  rejected,
  onConfig,
  agentDefaults,
}: FieldLineProps<{ fields: AutopilotField[] }>) {
  const [overriding, setOverriding] = useState(false);
  const changed = fields.filter((f) => fieldChanged(automation, f, entry.config, agentDefaults));
  const open = overriding || changed.length > 0;
  const summary = agentSummary(fields, entry.effectiveConfig);
  const limits = <SettingsLink to="autopilot.limits.agent-defaults">Limits &amp; safety</SettingsLink>;
  const resetAll = () => {
    onConfig((current) => fields.reduce((config, f) => withConfigValue(config, f.key, undefined), current));
    setOverriding(false);
  };
  return (
    <>
      <SettingsRow
        id={`autopilot.automations.${automation.key}.agent`}
        title={agentFieldsTitle(fields)}
        description={
          changed.length > 0 ? (
            <>
              {changed.length} set here, the rest from {limits}.
            </>
          ) : (
            <>The defaults from {limits}.</>
          )
        }
        status={summary ? `Now: ${summary}` : undefined}
        control={
          open ? (
            <Button
              size="xs"
              variant="outline"
              title={`Put all ${fields.length} back to Limits & safety`}
              onClick={resetAll}
            >
              <Undo2Icon />
              Reset
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setOverriding(true)}>
              Override
            </Button>
          )
        }
      />
      {open
        ? fields.map((f) => (
            <AutomationField
              key={f.key}
              automation={automation}
              field={f}
              entry={entry}
              projectId={null}
              rejected={rejected}
              onConfig={onConfig}
              defaults={{ value: fieldDefault(automation, f, agentDefaults) }}
              // Resetting one field keeps the others open, even when it was the last one set here.
              onReset={() => setOverriding(true)}
              // Tinted rather than indented: an indent would narrow the row past its breakpoint in a narrow pane.
              className="rounded-none bg-muted/25"
            />
          ))
        : null}
    </>
  );
}

/** Over an automation in Preview: how often it would have run this week, its runs, and Turn on. */
function PreviewNotice({
  count,
  automation,
  disabled,
  onTurnOn,
}: {
  count: number;
  automation: string;
  disabled: boolean;
  onTurnOn: () => void;
}) {
  return (
    <div className="px-3 sm:px-4">
      <Alert variant="warning">
        <EyeIcon />
        {/* The buttons sit under the text, so a narrow detail pane doesn't squeeze it into a column. */}
        <AlertDescription>
          <p>{previewHint(count)}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <Button size="xs" variant="warning-outline" disabled={disabled} onClick={onTurnOn}>
              Turn on
            </Button>
            {count > 0 ? <RunHistoryLink automation={automation} label="See them" size="xs" /> : null}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** The rest of an automation's settings, closed until asked for; its header counts what isn't the default. */
function AdvancedSection({
  changed,
  fields,
  children,
}: {
  /** How many fields in it differ from their default. */
  changed: number;
  fields: string[];
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="px-3 sm:px-4">
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="rounded-xl border border-border/60 bg-card/40 shadow-xs/5"
      >
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-3 text-left outline-none hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring rounded-xl sm:px-4">
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <span className="text-sm text-foreground">Advanced</span>
          {/* The names truncate; the count after them never does. */}
          <span className="flex min-w-0 flex-1 gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">{fields.join(", ")}</span>
            {changed > 0 ? <span className="shrink-0 text-info-foreground">· {changed} changed</span> : null}
          </span>
        </CollapsibleTrigger>
        <CollapsiblePanel className="border-t border-border/50 [&>div>*+*]:border-t [&>div>*+*]:border-border/50">
          <div>{children}</div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

/** A custom automation's own actions in the header: Export and Delete (Edit has a row of its own). */
function CustomActions({ custom }: { custom: CustomAutomation }) {
  const remove = useDeleteCustomAutomation();
  const exporting = useExportCustomAutomation();
  const [deleting, setDeleting] = useState(false);
  const onExport = () =>
    exporting.mutate(custom.id, {
      onSuccess: (bundle) => {
        downloadText(bundleFilename(custom.name), `${JSON.stringify(bundle, null, 2)}\n`);
        if (bundle.skill) {
          toastManager.add({
            type: "info",
            title: `The skill ${bundle.skill.name} is in the file`,
            description: "Only its SKILL.md travels, not other files beside it. Check it for anything private.",
          });
        }
      },
    });
  return (
    <>
      <Button size="xs" variant="ghost-muted" disabled={exporting.isPending} onClick={onExport}>
        Export
      </Button>
      <Button size="xs" variant="ghost-destructive" onClick={() => setDeleting(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${custom.name}?`}
        description="Its switches go with it. Its past runs stay in the history."
        confirmLabel="Delete"
        onConfirm={() => remove.mutate(custom.id)}
      />
    </>
  );
}

/** The custom automation behind a catalogue entry, or null for a built-in. */
export function customOf(customs: readonly CustomAutomation[] | undefined, key: string): CustomAutomation | null {
  const id = customAutomationId(key);
  return id ? (customs?.find((c) => c.id === id) ?? null) : null;
}

const HERE_WORDS: Record<WhereState, string> = { on: "On here", preview: "Preview here", off: "Off here" };
const HERE_TONES: Record<WhereState, "success" | "warning" | "muted"> = {
  on: "success",
  preview: "warning",
  off: "muted",
};

/**
 * What an automation does in one project and how to change it there: its state there, the switch that sets the
 * project's exception (the lane pill's popover writes the same, through `scopeToggle`), and the settings the project
 * sets for itself, which apply over the board's.
 */
function useProjectHere(automation: AutopilotAutomation, project: Project) {
  const { input, apply } = useWhere(automation);
  const scope = { kind: "project", id: project.id } as const;
  const state = input ? scopeState(input, scope) : null;
  const own = useAutopilotScope(project.id).data?.find((e) => e.automation === automation.key)?.config ?? {};
  const ownLabel = ownSettingsLabel(automation, own);
  const reset = useSetAutopilotScope(project.id);
  return {
    state,
    ownLabel,
    ready: input !== null,
    busy: apply.isPending,
    toggle: (on: boolean) => {
      if (!input) return;
      const writes = scopeToggle(input, scope, on);
      if (writes.length > 0) apply.mutate(writes);
    },
    clearOwn: () => reset.mutate({ automation: automation.key, config: () => ({}) }),
    clearing: reset.isPending,
  };
}

/** A list row in project scope: the automation's state in that project, and its switch there. */
function ProjectListRow({
  item,
  project,
  pending,
  selected,
  onSelect,
}: {
  item: ListedAutomation;
  project: Project;
  pending: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { automation } = item;
  const here = useProjectHere(automation, project);
  const switchless = automation.alwaysOn;
  const on = here.state !== null && here.state !== "off";
  return (
    <SplitListItem
      id={`autopilot.automations.${automation.key}`}
      icon={<AutomationIcon automation={automation} />}
      title={automation.title}
      subtitle={
        switchless ? (
          "Each rule has its own switch"
        ) : here.state === null ? (
          "Loading..."
        ) : (
          <>
            <span className={cn(here.state === "preview" && "font-medium text-warning-foreground")}>
              {HERE_WORDS[here.state]}
            </span>
            {here.ownLabel ? " · Own settings" : null}
          </>
        )
      }
      dimmed={!switchless && here.state === "off"}
      selected={selected}
      onSelect={onSelect}
      trailing={
        switchless ? null : (
          <Switch
            size="sm"
            aria-label={`${automation.title} in ${project.title}`}
            checked={on}
            disabled={pending || here.busy || !here.ready || (!on && Boolean(automation.blocked))}
            title={!on && automation.blocked ? automation.blocked : undefined}
            onCheckedChange={here.toggle}
          />
        )
      }
    />
  );
}

/** The detail's section for the project chosen in the scope sentence: its state there, and its own settings. */
function ProjectHere({
  automation,
  project,
  pending,
}: {
  automation: AutopilotAutomation;
  project: Project;
  pending: boolean;
}) {
  const here = useProjectHere(automation, project);
  const on = here.state !== null && here.state !== "off";
  return (
    <DetailSection title={`In ${project.title}`}>
      <SettingsRow
        id={`autopilot.automations.${automation.key}.here`}
        scope="project"
        title={here.state === null ? "Loading..." : HERE_WORDS[here.state]}
        description="Switching it here makes an exception for this project; the board's setting stays as it is."
        status={
          here.state === null ? null : (
            <span className="flex items-center gap-1.5">
              <StatusDot tone={HERE_TONES[here.state]} label={HERE_WORDS[here.state]} />
              {here.state === "preview" ? "Records what it would do, without acting." : null}
            </span>
          )
        }
        control={
          <Switch
            aria-label={`${automation.title} in ${project.title}`}
            checked={on}
            disabled={pending || here.busy || !here.ready || (!on && Boolean(automation.blocked))}
            onCheckedChange={here.toggle}
          />
        }
      />
      {here.ownLabel ? (
        <SettingsRow
          scope="project"
          title="Own settings"
          description={`${project.title} sets its own ${here.ownLabel}, which apply over the board's.`}
          control={
            <Button
              size="xs"
              variant="outline"
              aria-label={`Clear ${automation.title}'s own settings for ${project.title}`}
              disabled={here.clearing}
              onClick={here.clearOwn}
            >
              Clear own settings
            </Button>
          }
        />
      ) : null}
    </DetailSection>
  );
}
