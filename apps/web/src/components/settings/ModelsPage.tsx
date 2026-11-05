import type { AgentHarness } from "@repo/contracts";
import {
  AGENT_HARNESSES,
  MODEL_PROFILES_MAX,
  MODEL_TIERS,
  OPERATIONS,
  type AppSettings,
  type CliEffort,
  type ModelProfile,
  type ModelTier,
  type ModelTierSetting,
  type OperationId,
  type T3IntegrationStatus,
  type T3ModelCatalog,
  type T3ModelSelection,
} from "@repo/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { resolvesTo } from "~/components/models/choicePicker.logic";
import { CliModelPicker, ModelChoicePicker } from "~/components/models/ModelChoicePicker";
import {
  boardPickerRows,
  boardPickerValue,
  boardUpdate,
  OPERATION_DESCRIPTIONS,
  OPERATION_GROUPS,
  operationTarget,
} from "~/components/models/operations.logic";
import { PickerIcon } from "~/components/models/PickerIcon";
import { T3ModelPicker } from "~/components/models/T3ModelPicker";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useRescanAgentModels, useUpdateSettings } from "~/state/mutations";
import { useAgentModels, useT3ModelCatalog } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import {
  createProfileEdits,
  labelConflicts,
  parseLabelList,
  saveProfileEdit,
  type ProfileEdit,
} from "./modelProfiles.logic";
import {
  createTierEdits,
  saveTierChange,
  TIER_PROVIDERS,
  tierProviderState,
  visibleTierProviders,
  type TierChange,
  type TierProvider,
} from "./modelTiers.logic";
import { SettingsLink, SettingsNote, SettingsRow, SettingsSection, SettingsSubsection } from "./settingsLayout";

/**
 * Settings → Models: what each tier means on each provider the user added, the custom models beyond them, and which
 * model each operation runs on. Planning agents pick a tier; the user picks the models here.
 */
export function ModelsPage({ settings, t3 }: { settings: AppSettings; t3: T3IntegrationStatus | undefined }) {
  const t3Ready = settings.t3TokenSet && t3?.detected === true;
  const shown = visibleTierProviders(tierProviderState(settings.providers));
  const catalog = useT3ModelCatalog(t3Ready && shown.includes("t3"));
  const cells: CellContext = {
    shown,
    t3Ready,
    catalog: catalog.data,
    catalogError: catalog.error?.message ?? null,
  };
  return (
    <>
      <SettingsSubsection id="agents.models">
        <TiersSection settings={settings} cells={cells} />
        <CustomModelsSection profiles={settings.modelProfiles} cells={cells} />
      </SettingsSubsection>
      <SettingsSubsection id="agents.operations">
        <OperationsSection settings={settings} />
      </SettingsSubsection>
    </>
  );
}

interface CellContext {
  /** The providers the user added and switched on, T3 Code included: the grid's columns. */
  shown: TierProvider[];
  t3Ready: boolean;
  catalog: T3ModelCatalog | undefined;
  catalogError: string | null;
}

const providerLabel = (provider: TierProvider) => TIER_PROVIDERS.find((p) => p.provider === provider)!.label;

/** Header row and every row of a grid share one column template: the name column, then one per provider. */
const gridTemplate = (columns: number) => ({
  gridTemplateColumns: `minmax(11rem, 1fr) repeat(${columns}, minmax(10rem, 1fr))`,
});

/** The narrowest the grid gets before it scrolls sideways: every column at its minimum, the gaps and the padding. */
const gridMinWidth = (columns: number) => `${11 + columns * 10.75 + 2}rem`;

function GridHeader({ shown }: { shown: readonly TierProvider[] }) {
  return (
    <div
      className="grid gap-3 border-b border-border/50 px-3 pt-2 pb-2 text-xs text-muted-foreground sm:px-4"
      style={gridTemplate(shown.length)}
      aria-hidden
    >
      <span />
      {shown.map((provider) => (
        <span key={provider} className="flex items-center gap-1.5">
          <PickerIcon
            icon={provider === "t3" ? { kind: "t3code" } : { kind: "harness", harness: provider }}
            className="size-3.5"
          />
          {providerLabel(provider)}
        </span>
      ))}
    </div>
  );
}

function TiersSection({ settings, cells }: { settings: AppSettings; cells: CellContext }) {
  const updateSettings = useUpdateSettings();
  const anyCli = cells.shown.some((p) => p !== "t3");
  const scanned = useAgentModels(anyCli);
  const rescan = useRescanAgentModels();
  const edits = useRef(createTierEdits()).current;
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (tier: ModelTier, change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);
  return (
    <SettingsSection
      id="agents.models.tiers.list"
      title="Tiers"
      headerAction={
        anyCli ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={rescan.isPending || scanned.isFetching}
            onClick={() => rescan.mutate()}
            title="Ask the CLIs which models they offer"
          >
            {rescan.isPending || scanned.isFetching ? <Spinner /> : <RefreshCwIcon />}
            Rescan models
          </Button>
        ) : null
      }
    >
      <ModelGrid shown={cells.shown}>
        {MODEL_TIERS.map(({ value: tier, label, description }) => {
          const setting = settings.modelTiers[tier];
          return (
            <GridRow key={tier} id={`agents.models.tiers.${tier}`} shown={cells.shown} label={`${label} tier`}>
              <div className="min-w-0 space-y-1.5">
                <h3 className="text-sm font-medium text-foreground" title={description}>
                  {label}
                </h3>
                <BlurInput
                  size="sm"
                  className="w-full"
                  aria-label={`${label} tier description`}
                  placeholder={setting.t3?.label ?? "Description, e.g. Sonnet, medium"}
                  value={setting.description ?? ""}
                  onSave={(next) => save(tier, { field: "description", value: next.trim() || null })}
                />
              </div>
              {cells.shown.map((provider) => (
                <ProviderCell
                  key={provider}
                  provider={provider}
                  group={`tier-${tier}`}
                  name={`${label} tier`}
                  setting={setting}
                  cells={cells}
                  onChange={(change) => save(tier, change)}
                />
              ))}
            </GridRow>
          );
        })}
      </ModelGrid>
      <SettingsNote>
        A tier's description is named in prompts copied from a task; each cell is the model a session on that provider
        starts on when a task suggests the tier (empty: the provider's default). Headless runs use the provider marked
        Preferred when it can do what the run needs, else the first that can in{" "}
        <SettingsLink to="agents.providers">Providers</SettingsLink>.
        {cells.shown.length < TIER_PROVIDERS.length ? " A provider's column shows once you add it there." : null}
      </SettingsNote>
    </SettingsSection>
  );
}

function ModelGrid({ shown, children }: { shown: readonly TierProvider[]; children: ReactNode }) {
  if (shown.length === 0) {
    return (
      <SettingsNote>
        Add a provider in <SettingsLink to="agents.providers">Providers</SettingsLink> to set its models here.
      </SettingsNote>
    );
  }
  return (
    // Wide enough for every provider's column; scrolls sideways in a narrow window rather than squeezing them.
    <div className="overflow-x-auto">
      <div style={{ minWidth: gridMinWidth(shown.length) }}>
        <GridHeader shown={shown} />
        <div className="[&>*+*]:border-t [&>*+*]:border-border/50">{children}</div>
      </div>
    </div>
  );
}

function GridRow({
  id,
  shown,
  label,
  children,
}: {
  id: string;
  shown: readonly TierProvider[];
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="group"
      aria-label={label}
      className="grid scroll-mt-4 items-start gap-3 px-3 py-3 sm:px-4"
      style={gridTemplate(shown.length)}
    >
      {children}
    </div>
  );
}

/** One provider's model for a tier or custom model, and for a CLI whether headless runs prefer it. */
function ProviderCell({
  provider,
  group,
  name,
  setting,
  cells,
  onChange,
}: {
  provider: TierProvider;
  /** The tier's value or the custom model's id, unique on the page. */
  group: string;
  name: string;
  setting: ModelTierSetting;
  cells: CellContext;
  onChange: (change: TierChange) => void;
}) {
  if (provider === "t3") {
    return (
      <T3Cell name={name} setting={setting} cells={cells} onChange={(value) => onChange({ field: "t3", value })} />
    );
  }
  const model = setting.cli?.[provider] ?? "";
  const label = AGENT_HARNESSES[provider].label;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <CliModelPicker
          harness={provider}
          model={model}
          effort={setting.cliEffort?.[provider] ?? null}
          defaultLabel="Default model"
          ariaLabel={`${name} ${label} model`}
          className="max-w-full"
          onModel={(value: string | null, levels: readonly CliEffort[]) =>
            onChange({ field: "cli", harness: provider, value, levels })
          }
          onEffort={(value) => onChange({ field: "cliEffort", harness: provider, value })}
        />
        {model.trim() ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Clear ${name} ${label} model`}
            onClick={() => onChange({ field: "cli", harness: provider, value: null })}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      <PreferredRadio group={group} harness={provider} value={setting.provider} onChange={onChange} />
    </div>
  );
}

/** The radio that makes this provider the one headless runs on this model prefer. */
function PreferredRadio({
  group,
  harness,
  value,
  onChange,
}: {
  /** The tier's or custom model's id: names are free text, and two may be the same. */
  group: string;
  harness: AgentHarness;
  value: AgentHarness | undefined;
  onChange: (change: TierChange) => void;
}) {
  return (
    <label className="ms-2.5 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground has-checked:text-foreground">
      <input
        type="radio"
        className="size-3 accent-primary"
        name={`preferred-${group}`}
        checked={value === harness}
        onChange={() => onChange({ field: "headless", value: harness })}
      />
      Preferred
    </label>
  );
}

function T3Cell({
  name,
  setting,
  cells,
  onChange,
}: {
  name: string;
  setting: ModelTierSetting;
  cells: CellContext;
  onChange: (t3: ModelTierSetting["t3"]) => void;
}) {
  const selection = setting.t3?.selection ?? null;
  const { catalog } = cells;
  const clear = selection ? (
    <Button
      size="icon-xs"
      variant="ghost-muted"
      aria-label={`Clear ${name} T3 Code model`}
      onClick={() => onChange(null)}
    >
      <XIcon />
    </Button>
  ) : null;
  if (!cells.t3Ready || !catalog) {
    return (
      <span className="flex min-h-7 min-w-0 items-center gap-1 ps-2.5 text-xs text-muted-foreground">
        <span className="truncate">
          {(cells.t3Ready ? cells.catalogError : null) ??
            setting.t3?.label ??
            (cells.t3Ready ? "Loading models..." : "Not connected")}
        </span>
        {clear}
      </span>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-1">
      <T3ModelPicker
        catalog={catalog}
        selection={selection}
        ariaLabel={`${name} T3 Code model`}
        className="max-w-full"
        onChange={(next: T3ModelSelection) => onChange({ selection: next, label: selectionLabel(catalog, next) })}
      />
      {clear}
    </div>
  );
}

/**
 * Named models beyond the tiers: each has a tier's cells, and task labels that pick it whatever the task's tier. A
 * model picker anywhere can pick one too.
 */
function CustomModelsSection({ profiles, cells }: { profiles: readonly ModelProfile[]; cells: CellContext }) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createProfileEdits()).current;
  const save = (edit: ProfileEdit) => void saveProfileEdit(edits, updateSettings.mutateAsync, profiles, edit);
  const change = (id: string, next: Extract<ProfileEdit, { kind: "change" }>["change"]) =>
    save({ kind: "change", id, change: next });
  const conflicts = labelConflicts(profiles);
  return (
    <SettingsSection
      id="agents.models.custom.list"
      title="Custom models"
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          disabled={profiles.length >= MODEL_PROFILES_MAX}
          onClick={() => save({ kind: "add", name: "New model" })}
        >
          <PlusIcon />
          Add model
        </Button>
      }
    >
      {profiles.length === 0 ? (
        <SettingsNote>
          None yet. Add one to run tasks that carry its label (say codex61) on it whatever their tier, or to pick it for
          an operation or an automation.
        </SettingsNote>
      ) : (
        <ModelGrid shown={cells.shown}>
          {profiles.map((profile, index) => (
            <GridRow
              key={profile.id}
              id={`agents.models.custom.${profile.id}`}
              shown={cells.shown}
              label={profile.name}
            >
              <div className="min-w-0 space-y-1.5">
                <div className="flex min-w-0 items-center gap-0.5">
                  <BlurInput
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label="Model name"
                    value={profile.name}
                    onSave={(next) => change(profile.id, { field: "name", value: next })}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${profile.name} up`}
                    disabled={index === 0}
                    onClick={() => save({ kind: "move", id: profile.id, delta: -1 })}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Move ${profile.name} down`}
                    disabled={index === profiles.length - 1}
                    onClick={() => save({ kind: "move", id: profile.id, delta: 1 })}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${profile.name}`}
                    onClick={() => save({ kind: "remove", id: profile.id })}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                <BlurInput
                  size="sm"
                  className="w-full"
                  aria-label={`${profile.name} labels`}
                  placeholder="Labels, e.g. codex61"
                  value={profile.labels.join(", ")}
                  onSave={(next) => change(profile.id, { field: "labels", value: parseLabelList(next) })}
                />
                <BlurInput
                  size="sm"
                  className="w-full"
                  aria-label={`${profile.name} description`}
                  placeholder={profile.t3?.label ?? "Description, e.g. Codex, high"}
                  value={profile.description ?? ""}
                  onSave={(next) => change(profile.id, { field: "description", value: next.trim() || null })}
                />
              </div>
              {cells.shown.map((provider) => (
                <ProviderCell
                  key={provider}
                  provider={provider}
                  group={`profile-${profile.id}`}
                  name={profile.name}
                  setting={profile}
                  cells={cells}
                  onChange={(next) => change(profile.id, next)}
                />
              ))}
            </GridRow>
          ))}
        </ModelGrid>
      )}
      {conflicts.map(({ label, winner, shadowed }) => (
        <SettingsNote key={label}>
          Label {label} is on {[winner, ...shadowed].join(" and ")}: {winner} wins, being first in the list.
        </SettingsNote>
      ))}
    </SettingsSection>
  );
}

/**
 * The model each operation runs on, at board level, with the line saying what that comes down to now. A project, a
 * task (for the reviewer) and an automation can pick their own; those are set where they live.
 */
function OperationsSection({ settings }: { settings: AppSettings }) {
  return (
    <>
      {OPERATION_GROUPS.map((group) => (
        <SettingsSection key={group.id} id={`agents.operations.${group.id}`} title={group.title}>
          {group.operations.map((op) => (
            <OperationRow key={op} op={op} settings={settings} />
          ))}
        </SettingsSection>
      ))}
    </>
  );
}

function OperationRow({ op, settings }: { op: OperationId; settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const { unset, inherit } = boardPickerRows(op, settings);
  const line = resolvesTo(op, {}, settings);
  return (
    <SettingsRow
      id={operationTarget(op)}
      title={OPERATIONS[op].label}
      description={OPERATION_DESCRIPTIONS[op]}
      status={
        <span className={cn("block", !line.ok && "text-destructive-foreground")}>
          {line.text}
          {line.note ? <span className="block text-muted-foreground/80">{line.note}</span> : null}
        </span>
      }
      control={
        <ModelChoicePicker
          op={op}
          value={boardPickerValue(op, settings.operationModels)}
          unset={unset}
          inherit={inherit}
          ariaLabel={`${OPERATIONS[op].label} model`}
          size="sm"
          onChange={(next) => updateSettings.mutate({ operationModels: boardUpdate(op, next) })}
        />
      }
    />
  );
}
