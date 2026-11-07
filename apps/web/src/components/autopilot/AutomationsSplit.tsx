// Settings → Autopilot → Automations: every automation in one list down the left, grouped, each with its switch, and
// the picked one's detail on the right (the Providers page's split card). Built-ins switched off stay in the list,
// dimmed; custom automations are listed once, under Yours.
import {
  AUTOPILOT_DIGEST,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_MERGE_EPIC_PRS,
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_RECURRING,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_START_PLANNED,
  AUTOPILOT_UNSTICK,
  automationSentence,
  customAutomationId,
  splitFieldsByTier,
  whereEverywhere,
  type AutopilotAutomation,
  type AutopilotOverview,
  type CustomAutomation,
} from "@repo/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArchiveIcon,
  BellRingIcon,
  BotIcon,
  ChevronRightIcon,
  ClockAlertIcon,
  FileUpIcon,
  GitMergeIcon,
  type LucideIcon,
  NewspaperIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  ScanSearchIcon,
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
import { ConfirmDialog } from "~/components/task/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { downloadText } from "~/lib/download";
import { cn } from "~/lib/utils";
import { useDeleteCustomAutomation, useExportCustomAutomation } from "~/state/customAutomations";
import { AutomationField, type AutomationItem } from "./AutomationRows";
import {
  advancedChanged,
  groupAutomations,
  isOffEverywhere,
  rowSubline,
  selectedAutomation,
  statusLine,
  type AutomationReach,
  type LastRun,
} from "./automationList.logic";
import { bundleFilename } from "./customAutomationImport.logic";
import { BlockedWarning, NeedsVariablesWarning } from "./InputsAndSlots";
import { RunHistoryLink } from "./RunHistoryLink";
import { useWhere } from "./useWhere";
import { WhereItRuns } from "./WhereItRuns";

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  [AUTOPILOT_START_PLANNED]: PlayIcon,
  [AUTOPILOT_ORCHESTRATE]: WorkflowIcon,
  [AUTOPILOT_REVIEW_PRS]: ScanSearchIcon,
  [AUTOPILOT_FIX_PRS]: WrenchIcon,
  [AUTOPILOT_MERGE_EPIC_PRS]: GitMergeIcon,
  [AUTOPILOT_RECURRING]: RepeatIcon,
  auto_archive: ArchiveIcon,
  [AUTOPILOT_DIGEST]: NewspaperIcon,
  [AUTOPILOT_UNSTICK]: ClockAlertIcon,
  unblock_dependents: BellRingIcon,
};

function AutomationIcon({ automation, className }: { automation: AutopilotAutomation; className?: string }) {
  const Icon = BUILTIN_ICONS[automation.key] ?? (automation.needsAgent ? BotIcon : SquareTerminalIcon);
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** One automation with what the list and detail show of it. */
export interface ListedAutomation extends AutomationItem {
  reach: AutomationReach;
  lastRun: LastRun | undefined;
  custom: CustomAutomation | null;
}

/**
 * The board switch of a list row and of the detail's header: the shortcut for Everywhere. On is Everywhere, so the
 * project rows Only in… left are dropped with it and a later Off really is off; off is the board's Inherit.
 */
function useBoardSwitch(item: ListedAutomation): (on: boolean) => void {
  const { input, apply } = useWhere(item.automation);
  return (on) => {
    if (on && input) {
      const writes = whereEverywhere(input);
      if (writes.length > 0) apply.mutate(writes);
    } else item.onMode(on ? "on" : "inherit");
  };
}

/** The list and the picked automation's detail. The automation in `?automation=` is picked; with none, the first. */
export function AutomationsSplit({
  items,
  overview,
  pending,
  rejected,
}: {
  items: ListedAutomation[];
  overview: AutopilotOverview;
  pending: boolean;
  rejected: number;
}) {
  const navigate = useNavigate();
  const requested = useSearch({ strict: false, select: (search) => search.automation });
  const [adding, setAdding] = useState(false);
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
                    pending={pending}
                    selected={item.automation.key === selectedKey}
                    onSelect={() => select(item.automation.key)}
                  />
                ))}
              </SplitListGroup>
            ))}
            <SplitListAction
              icon={<PlusIcon className="size-4 shrink-0" />}
              label="Add automation"
              onClick={() => setAdding(true)}
            />
          </SplitList>
        }
      >
        {selected ? (
          <AutomationDetail
            key={selected.automation.key}
            item={selected}
            overview={overview}
            pending={pending}
            rejected={rejected}
            onBack={() => select(undefined)}
          />
        ) : (
          <SettingsNote>No automations are installed yet.</SettingsNote>
        )}
      </SplitCard>
      <AddAutomationDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function ListRow({
  item,
  pending,
  selected,
  onSelect,
}: {
  item: ListedAutomation;
  pending: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { automation, entry, reach, lastRun } = item;
  const setBoard = useBoardSwitch(item);
  const on = entry.mode === "on";
  const off = isOffEverywhere(reach);
  return (
    <SplitListItem
      id={`autopilot.automations.${automation.key}`}
      icon={<AutomationIcon automation={automation} />}
      title={automation.title}
      badge={
        off ? null : lastRun?.status === "failed" ? (
          <StatusDot tone="danger" label="Last run failed" />
        ) : (
          <StatusDot tone="success" label="On" />
        )
      }
      subtitle={rowSubline(reach, lastRun)}
      dimmed={off}
      selected={selected}
      onSelect={onSelect}
      trailing={
        <Switch
          size="sm"
          aria-label={`${automation.title} on for the board`}
          checked={on}
          disabled={pending || (!on && Boolean(automation.blocked))}
          title={!on && automation.blocked ? automation.blocked : undefined}
          onCheckedChange={setBoard}
        />
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
  overview,
  pending,
  rejected,
  onBack,
}: {
  item: ListedAutomation;
  overview: AutopilotOverview;
  pending: boolean;
  rejected: number;
  onBack: () => void;
}) {
  const { automation, entry, reach, custom, onConfig } = item;
  const setBoard = useBoardSwitch(item);
  const navigate = useNavigate();
  const { essential, advanced } = splitFieldsByTier(automation.fields);
  const on = entry.mode === "on";
  const off = isOffEverywhere(reach);
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
            <StatusDot tone={off ? "muted" : "success"} label={off ? "Off" : "On"} />
            <span className="truncate">{statusLine(reach)}</span>
            {custom ? (
              <Badge variant="outline" size="sm">
                Custom
              </Badge>
            ) : null}
          </span>
        }
        actions={
          <>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pending || (!on && Boolean(automation.blocked))}
              onClick={() => setBoard(!on)}
            >
              {on ? "Switch off" : "Switch on"}
            </Button>
            {custom ? <CustomActions custom={custom} /> : null}
          </>
        }
      />
      {automation.blocked || automation.needs ? (
        <div className="space-y-2 px-3 sm:px-4">
          {automation.blocked ? <BlockedWarning reason={automation.blocked} /> : null}
          {automation.needs ? <NeedsVariablesWarning needs={automation.needs} /> : null}
        </div>
      ) : null}
      <DetailSection title="What it does">
        <div className="flex flex-col gap-3 px-3 py-3 @min-[32rem]/split:flex-row @min-[32rem]/split:items-start sm:px-4">
          <p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
            {automationSentence(automation, entry.effectiveConfig, { custom, engine: overview.engine })}
          </p>
          <div className="shrink-0 self-start">
            <RunHistoryLink automation={automation.key} label="All runs" size="xs" />
          </div>
        </div>
      </DetailSection>
      <WhereItRuns automation={automation} />
      {automation.key === AUTOPILOT_ORCHESTRATE ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          Each lane&apos;s pill also shows Orchestrate&apos;s next check and has Run now.
        </p>
      ) : null}
      {essential.length > 0 ? <DetailSection title="Settings">{essential.map(field)}</DetailSection> : null}
      {automation.key === AUTOPILOT_RECURRING ? (
        <DetailSection title="Rules">
          <SettingsRow
            title="Recurring rules"
            description={
              <>
                Each project keeps its own rules, in <SettingsLink to="project.recurring">its settings</SettingsLink>. A
                rule that is on makes its task when it comes due, while this is on in the project.
              </>
            }
          />
        </DetailSection>
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
          fields={advanced.map((f) => f.label)}
        >
          {advanced.map(field)}
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

/**
 * + Add automation, until the gallery: start a custom automation from scratch in the editor, or import one from a
 * file or the examples.
 */
function AddAutomationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const choices = [
    {
      icon: PlusIcon,
      title: "New automation",
      blurb: "Pick what it watches for, then start an agent with your prompt, or run a command or a script.",
      go: () =>
        void navigate({
          to: "/settings/autopilot/custom/$customId",
          params: { customId: "new" },
          state: FROM_SETTINGS_LIST,
        }),
    },
    {
      icon: FileUpIcon,
      title: "Import",
      blurb: "From a file someone shared, or one of the examples. It comes in switched off.",
      go: () => void navigate({ to: "/settings/autopilot/custom/import", state: FROM_SETTINGS_LIST }),
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add automation</DialogTitle>
          <DialogDescription>
            The built-in automations are already in the list: switch one on there. These are your own.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-2 sm:grid-cols-2">
            {choices.map(({ icon: Icon, title, blurb, go }) => (
              <button
                key={title}
                type="button"
                className="flex cursor-pointer flex-col items-start gap-2 rounded-lg border border-border/60 p-3 text-left transition-colors outline-none hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onOpenChange(false);
                  go();
                }}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon aria-hidden className="size-4" />
                  {title}
                </span>
                <span className="text-xs text-muted-foreground">{blurb}</span>
              </button>
            ))}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The custom automation behind a catalogue entry, or null for a built-in. */
export function customOf(customs: readonly CustomAutomation[] | undefined, key: string): CustomAutomation | null {
  const id = customAutomationId(key);
  return id ? (customs?.find((c) => c.id === id) ?? null) : null;
}
