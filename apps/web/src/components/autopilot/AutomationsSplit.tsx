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
  OPERATIONS,
  splitFieldsByTier,
  type AutopilotAutomation,
  type AutopilotField,
  type AutopilotScopeEntry,
  type CustomAutomation,
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
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { downloadText } from "~/lib/download";
import { cn } from "~/lib/utils";
import { inheritDetail } from "~/components/models/choicePicker.logic";
import { operationTarget } from "~/components/models/operations.logic";
import { useDeleteCustomAutomation, useExportCustomAutomation } from "~/state/customAutomations";
import { useAutopilotOverview } from "~/state/queries";
import { useSettings } from "~/state/queries";
import { AutomationField, type AutomationItem, type ConfigUpdate } from "./AutomationRows";
import {
  advancedChanged,
  advancedFieldNames,
  agentFieldsTitle,
  agentSummary,
  groupAutomations,
  isOffEverywhere,
  lastRunText,
  projectsStatus,
  rowSubline,
  selectedAutomation,
  splitAgentFields,
  statusLine,
  type AutomationReach,
  type LastRun,
} from "./automationList.logic";
import {
  BOARD_MODES,
  boardModeToSave,
  boardSummary,
  boardSwitchValue,
  modeDescription,
  previewHint,
  restoreMode,
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
  const requested = useSearch({ strict: false, select: (search) => search.automation });
  const [adding, setAdding] = useState(false);
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
      search: automation ? { automation } : {},
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
                {group.items.map((item) => (
                  <ListRow
                    key={item.automation.key}
                    item={item}
                    paused={pausedText(pausesFor(autoPaused, item.automation.key))}
                    pending={pending}
                    selected={item.automation.key === selectedKey}
                    onSelect={() => select(item.automation.key)}
                  />
                ))}
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
  const { automation, entry, reach, lastRun, onMode } = item;
  const on = isOnMode(entry.mode);
  const off = !automation.alwaysOn && isOffEverywhere(reach);
  return (
    <SplitListItem
      id={`autopilot.automations.${automation.key}`}
      icon={<AutomationIcon automation={automation} />}
      title={automation.title}
      badge={
        off ? null : paused ? (
          <StatusDot tone="warning" label={paused} />
        ) : entry.mode === "preview" ? (
          <PreviewBadge />
        ) : lastRun?.status === "failed" ? (
          <StatusDot tone="danger" label="Last run failed" />
        ) : automation.alwaysOn ? null : (
          <StatusDot tone="success" label="On" />
        )
      }
      subtitle={paused && !off ? paused : automation.alwaysOn ? lastRunText(lastRun) : rowSubline(reach, lastRun)}
      dimmed={off}
      selected={selected}
      onSelect={onSelect}
      // Recurring tasks has no switch: each of its rules has its own, in the detail.
      trailing={
        automation.alwaysOn ? null : (
          <Switch
            size="sm"
            aria-label={`${automation.title} on for the board`}
            checked={on}
            disabled={pending || (!on && Boolean(automation.blocked))}
            title={!on && automation.blocked ? automation.blocked : undefined}
            // Back on in the mode it was last on in, or Preview for one that has never run.
            onCheckedChange={(next) => onMode(next ? restoreMode(entry, lastRun !== undefined) : "inherit")}
          />
        )
      }
    />
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
  const { automation, entry, reach, custom, lastRun, previewRuns, onMode, onConfig } = item;
  const navigate = useNavigate();
  const { essential, advanced } = splitFieldsByTier(automation.fields);
  const overview = useAutopilotOverview().data;
  const hints = hintsFor(overview?.hints ?? [], automation.key);
  const pauses = pausesFor(overview?.autoPaused ?? [], automation.key);
  const agent = splitAgentFields(advanced);
  const on = isOnMode(entry.mode);
  const preview = entry.mode === "preview";
  const switchless = automation.alwaysOn;
  const off = !switchless && isOffEverywhere(reach);
  const checkScript = hasCheckScript(custom);
  const editCustom = (id: string) =>
    void navigate({ to: "/settings/autopilot/custom/$customId", params: { customId: id }, state: FROM_SETTINGS_LIST });
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
                tone={off ? "muted" : preview ? "warning" : "success"}
                label={off ? "Off" : preview ? "Preview" : "On"}
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
            {switchless ? null : (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending || (!on && Boolean(automation.blocked))}
                onClick={() => onMode(on ? "inherit" : restoreMode(entry, lastRun !== undefined))}
              >
                {on ? "Switch off" : "Switch on"}
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
          onTurnOn={() => onMode("on")}
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
            title="Mode"
            description={modeDescription(
              boardSwitchValue(entry.mode) as "off" | "preview" | "on",
              automation,
              checkScript,
            )}
            info="Off: nothing runs. Preview: each time it would act, a run marked Preview is recorded instead; no agent starts and nothing on the board or on GitHub changes. A custom automation's check script is the exception: it runs for real. New, imported and drafted automations save in Preview."
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
          />
        )}
      </DetailSection>
      {switchless ? <RecurringRulesByProject /> : null}
      {switchless ? null : (
        <DetailSection title="Where it runs">
          <SettingsRow
            title="Whole board"
            description="Every project follows the mode above, unless a project or epic sets its own."
            status={boardSummary(entry.mode)}
          />
          <SettingsRow
            title="Projects"
            description={
              <>
                A project switches it for itself in its lane&apos;s Autopilot pill, or in{" "}
                <SettingsLink to="project.autopilot">its settings</SettingsLink>
                {automation.epicScope ? "; an epic, in its own Autopilot popover." : "."}
                {automation.key === AUTOPILOT_ORCHESTRATE
                  ? " Each lane's pill also shows the next check and has Run now."
                  : ""}
              </>
            }
            status={projectsStatus(reach)}
          />
          <PausedRows pauses={pauses} />
        </DetailSection>
      )}
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
            description="Its trigger, filters, prompt or command, inputs and tool slots, in the automation editor."
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
          changed={advancedChanged(automation, entry.effectiveConfig)}
          fields={advancedFieldNames(advanced)}
        >
          {agent.model?.kind === "model" ? (
            <ModelLine
              automation={automation}
              field={agent.model}
              entry={entry}
              rejected={rejected}
              onConfig={onConfig}
            />
          ) : null}
          {agent.runner.length > 0 ? (
            <AgentDefaultsLine
              automation={automation}
              fields={agent.runner}
              entry={entry}
              rejected={rejected}
              onConfig={onConfig}
            />
          ) : null}
          {agent.rest.map(field)}
        </AdvancedSection>
      ) : null}
      {off && !custom ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {automation.title} is off everywhere. Its settings are kept for when you switch it on.
        </p>
      ) : null}
    </DetailBody>
  );
}

type FieldLineProps<F> = {
  automation: AutopilotAutomation;
  entry: AutopilotScopeEntry;
  rejected: number;
  onConfig: ConfigUpdate;
} & F;

/**
 * The agent's model as one line: where it comes from (Agents → Operations, for runs of this kind) and what that resolves
 * to, with Override. Once overridden here, or while overriding, it is the model picker with a reset.
 */
function ModelLine({
  automation,
  field,
  entry,
  rejected,
  onConfig,
}: FieldLineProps<{ field: Extract<AutopilotField, { kind: "model" }> }>) {
  const settings = useSettings().data;
  const [overriding, setOverriding] = useState(false);
  const op = field.operation ?? "customTask";
  if (overriding || field.key in entry.config || !settings) {
    return (
      <AutomationField
        automation={automation}
        field={field}
        entry={entry}
        projectId={null}
        rejected={rejected}
        onConfig={onConfig}
      />
    );
  }
  return (
    <SettingsRow
      id={`autopilot.automations.${automation.key}.model`}
      title="Model"
      description={
        <>
          From <SettingsLink to={operationTarget(op)}>Agents → Operations</SettingsLink> ({OPERATIONS[op].label}), for
          every run of this kind.
        </>
      }
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
 * Runner, budget, timeout and T3 access as one line: the board's defaults from Limits & safety, or what this
 * automation sets, with Override. Overriding opens a row per field, each with a reset; the line stays open while
 * any of them is set here.
 */
function AgentDefaultsLine({
  automation,
  fields,
  entry,
  rejected,
  onConfig,
}: FieldLineProps<{ fields: AutopilotField[] }>) {
  const [overriding, setOverriding] = useState(false);
  const overridden = fields.filter((f) => f.key in entry.config);
  const open = overriding || overridden.length > 0;
  const summary = agentSummary(fields, entry.effectiveConfig);
  return (
    <>
      <SettingsRow
        id={`autopilot.automations.${automation.key}.agent`}
        title={agentFieldsTitle(fields)}
        description={
          overridden.length > 0 ? (
            <>
              Set here: {overridden.map((f) => f.label.toLowerCase()).join(", ")}. The rest come from{" "}
              <SettingsLink to="autopilot.limits.agent-defaults">Limits &amp; safety</SettingsLink>.
            </>
          ) : (
            <>
              The defaults from <SettingsLink to="autopilot.limits.agent-defaults">Limits &amp; safety</SettingsLink>.
            </>
          )
        }
        status={summary}
        control={
          overridden.length > 0 ? undefined : (
            <Button size="xs" variant="outline" onClick={() => setOverriding(!open)}>
              {open ? "Done" : "Override"}
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
            />
          ))
        : null}
    </>
  );
}

/** Beside a list row's name: the automation only records what it would do. */
function PreviewBadge() {
  return (
    <Badge variant="warning" size="sm" title="In Preview: it records what it would do and does none of it">
      Preview
    </Badge>
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

/** The rest of an automation's settings, closed until asked for; a dot says something in it isn't the default. */
function AdvancedSection({
  changed,
  fields,
  children,
}: {
  changed: boolean;
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
          {changed ? (
            <span
              role="img"
              aria-label="Changed from the default"
              title="Something here isn't the default"
              className="size-1.5 shrink-0 rounded-full bg-info"
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{fields.join(", ")}</span>
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
