import {
  MODEL_PROFILES_MAX,
  MODEL_TIERS,
  AGENT_HARNESSES,
  AgentHarness,
  modelEffortLevels,
  type AgentModel,
  type AgentModels,
  type AppSettings,
  type ModelProfile,
  type ModelTier,
  type T3IntegrationStatus,
  type T3ModelCatalog,
  type T3ModelSelection,
  type ModelTierSetting,
} from "@repo/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { ModelPicker, TraitsPicker } from "~/components/handoff/T3LaunchPickers";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { Button } from "~/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { useRescanAgentModels, useUpdateSettings } from "~/state/mutations";
import { useAgentIntegrations, useAgentModels, useT3ModelCatalog } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { findSuggestion } from "./cliModelPicker.logic";
import { CliEffortMenu, CliModelPicker } from "./CliModelPicker";
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
  visibleTierProviders,
  type TierChange,
  type TierProvider,
} from "./modelTiers.logic";
import { SettingsLink, SettingsNote, SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_LABELS: Record<AgentHarness, string> = Object.fromEntries(
  AgentHarness.options.map((h) => [h, AGENT_HARNESSES[h].label]),
) as Record<AgentHarness, string>;

/**
 * What each suggested model tier means, in one place for every provider: a description named in copied prompts, the
 * T3 Code model "New T3 Code thread" starts on, and the `--model` a new Claude Code or Copilot CLI session starts on.
 * Planning agents pick the tier; the user picks the models here. A provider's field shows once it is set up.
 */
export function ModelTiersSection({ settings, t3 }: { settings: AppSettings; t3: T3IntegrationStatus | undefined }) {
  const updateSettings = useUpdateSettings();
  const agents = useAgentIntegrations();
  const t3Ready = settings.t3TokenSet && t3?.detected === true;
  const catalog = useT3ModelCatalog(t3Ready);
  const cliFound: Partial<Record<AgentHarness, boolean>> = {};
  for (const harness of agents.data?.harnesses ?? []) cliFound[harness.harness] = harness.cli.found;
  // A provider set on a custom model shows too, so its value can be seen and cleared.
  const shown = new Set<TierProvider>(
    visibleTierProviders(settings.modelTiers, { t3Ready, cliFound }, settings.modelProfiles),
  );
  // Asked only once a CLI's field is on the page: scanning starts the CLI.
  const anyCli = shown.has("claude-code") || shown.has("copilot-cli");
  const scanned = useAgentModels(anyCli);
  const rescan = useRescanAgentModels();
  const edits = useRef(createTierEdits()).current;
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  // The hook's own onError already reports a failure.
  const save = (tier: ModelTier, change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);

  return (
    <>
      <SettingsSection
        id="models.tiers.list"
        title="Model tiers"
        headerAction={
          anyCli ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={rescan.isPending || scanned.isFetching}
              onClick={() => rescan.mutate()}
              title="Ask Claude Code and Copilot CLI which models they offer"
            >
              {rescan.isPending || scanned.isFetching ? <Spinner /> : <RefreshCwIcon />}
              Rescan models
            </Button>
          ) : null
        }
      >
        {MODEL_TIERS.map(({ value: tier, label, description }) => {
          const setting = settings.modelTiers[tier];
          return (
            <SettingsRow
              key={tier}
              id={`models.tiers.${tier}`}
              title={label}
              description={description}
              info="The description is named in prompts copied from a task. Each model below starts a new session on that provider when a task suggests this tier; empty uses the provider's default."
            >
              <div className="mt-3 space-y-2">
                <TierField label="Description">
                  <BlurInput
                    size="sm"
                    className="w-full sm:max-w-sm"
                    aria-label={`${label} tier description`}
                    placeholder={setting.t3?.label ?? "e.g. Sonnet, medium effort"}
                    value={setting.description ?? ""}
                    onSave={(next) => save(tier, { field: "description", value: next.trim() || null })}
                  />
                </TierField>
                {shown.has("t3") ? (
                  <TierField label="T3 Code">
                    <T3TierModel
                      catalog={catalog.data}
                      error={catalog.error?.message ?? null}
                      setting={setting}
                      canPick={t3Ready}
                      onChange={(value) => save(tier, { field: "t3", value })}
                    />
                  </TierField>
                ) : null}
                {AgentHarness.options.map((harness) =>
                  shown.has(harness) ? (
                    <TierField key={harness} label={CLI_LABELS[harness]}>
                      <CliModelField
                        harness={harness}
                        name={`${label} tier`}
                        setting={setting}
                        models={modelsOf(scanned.data, harness)}
                        scanning={scanned.isFetching}
                        onChange={(change) => save(tier, change)}
                      />
                    </TierField>
                  ) : null,
                )}
                <HeadlessHarness
                  name={`${label} tier`}
                  value={setting.headless}
                  onChange={(value) => save(tier, { field: "headless", value })}
                />
              </div>
            </SettingsRow>
          );
        })}
        {(["claude-code", "copilot-cli"] as const).map((harness) => {
          const status = scanned.data?.harnesses.find((h) => h.harness === harness);
          return shown.has(harness) && status?.error ? (
            <SettingsNote key={harness}>
              Couldn't list {CLI_LABELS[harness]}'s models: {status.error}. A model can still be typed.
            </SettingsNote>
          ) : null;
        })}
        {/* Not while the CLI check is still answering: the fields would appear and the hint go. */}
        {shown.size < TIER_PROVIDERS.length && !agents.isPending ? (
          <p className="px-3 py-3 text-xs text-muted-foreground/80 sm:px-4">
            A provider's model shows here once it is set up. See{" "}
            <SettingsLink to="integrations">Integrations</SettingsLink>.
          </p>
        ) : null}
      </SettingsSection>
      <CustomModelsSection
        profiles={settings.modelProfiles}
        shown={shown}
        t3Ready={t3Ready}
        catalog={catalog.data}
        catalogError={catalog.error?.message ?? null}
        scanned={scanned.data}
        scanning={scanned.isFetching}
      />
    </>
  );
}

/**
 * Named models beyond the tiers: each has the fields a tier has, and task labels that pick it whatever the task's
 * tier. An automation's Model setting can pick one too.
 */
function CustomModelsSection({
  profiles,
  shown,
  t3Ready,
  catalog,
  catalogError,
  scanned,
  scanning,
}: {
  profiles: readonly ModelProfile[];
  shown: ReadonlySet<TierProvider>;
  t3Ready: boolean;
  catalog: T3ModelCatalog | undefined;
  catalogError: string | null;
  scanned: AgentModels | undefined;
  scanning: boolean;
}) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createProfileEdits()).current;
  const save = (edit: ProfileEdit) => void saveProfileEdit(edits, updateSettings.mutateAsync, profiles, edit);
  const change = (id: string, next: Extract<ProfileEdit, { kind: "change" }>["change"]) =>
    save({ kind: "change", id, change: next });
  const conflicts = labelConflicts(profiles);
  return (
    <SettingsSection
      id="models.tiers.custom"
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
          None yet. Add one to run tasks that carry its label (say codex61) on it whatever their tier, or to pick it in
          an automation's Model setting.
        </SettingsNote>
      ) : null}
      {profiles.map((profile, index) => (
        <SettingsRow
          key={profile.id}
          id={`models.tiers.custom.${profile.id}`}
          title={
            <BlurInput
              size="sm"
              className="w-full sm:max-w-56"
              aria-label="Model name"
              value={profile.name}
              onSave={(next) => change(profile.id, { field: "name", value: next })}
            />
          }
          control={
            <>
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
            </>
          }
        >
          <div className="mt-3 space-y-2">
            <TierField label="Labels">
              <BlurInput
                size="sm"
                className="w-full sm:max-w-sm"
                aria-label={`${profile.name} labels`}
                placeholder="e.g. codex61 (comma-separated)"
                value={profile.labels.join(", ")}
                onSave={(next) => change(profile.id, { field: "labels", value: parseLabelList(next) })}
              />
            </TierField>
            <TierField label="Description">
              <BlurInput
                size="sm"
                className="w-full sm:max-w-sm"
                aria-label={`${profile.name} description`}
                placeholder={profile.t3?.label ?? "e.g. Codex, high effort"}
                value={profile.description ?? ""}
                onSave={(next) => change(profile.id, { field: "description", value: next.trim() || null })}
              />
            </TierField>
            {shown.has("t3") ? (
              <TierField label="T3 Code">
                <T3TierModel
                  catalog={catalog}
                  error={catalogError}
                  setting={profile}
                  canPick={t3Ready}
                  onChange={(value) => change(profile.id, { field: "t3", value })}
                />
              </TierField>
            ) : null}
            {AgentHarness.options.map((harness) =>
              shown.has(harness) ? (
                <TierField key={harness} label={CLI_LABELS[harness]}>
                  <CliModelField
                    harness={harness}
                    name={profile.name}
                    setting={profile}
                    models={modelsOf(scanned, harness)}
                    scanning={scanning}
                    onChange={(next) => change(profile.id, next)}
                  />
                </TierField>
              ) : null,
            )}
            <HeadlessHarness
              name={profile.name}
              value={profile.headless}
              onChange={(value) => change(profile.id, { field: "headless", value })}
            />
          </div>
        </SettingsRow>
      ))}
      {conflicts.map(({ label, winner, shadowed }) => (
        <SettingsNote key={label}>
          Label {label} is on {[winner, ...shadowed].join(" and ")}: {winner} wins, being first in the list.
        </SettingsNote>
      ))}
    </SettingsSection>
  );
}

const modelsOf = (scanned: AgentModels | undefined, harness: AgentHarness): readonly AgentModel[] =>
  scanned?.harnesses.find((h) => h.harness === harness)?.models ?? [];

/**
 * A CLI's `--model` for a tier or custom model, with its `--effort` beside it once a model is set. The effort offers
 * what the model's scan lists, else the CLI's own levels; a new model that doesn't take the saved effort clears it.
 * Laid out like the T3 Code row above it: model, effort, then a button that clears the model (the CLI's default).
 */
function CliModelField({
  harness,
  name,
  setting,
  models,
  scanning,
  onChange,
}: {
  harness: AgentHarness;
  name: string;
  setting: ModelTierSetting;
  models: readonly AgentModel[];
  scanning: boolean;
  onChange: (change: TierChange) => void;
}) {
  const model = setting.cli?.[harness] ?? "";
  const levels = modelEffortLevels(harness, findSuggestion(models, model));
  return (
    <>
      <CliModelPicker
        harness={harness}
        cliName={CLI_LABELS[harness]}
        label={`${name} ${CLI_LABELS[harness]} model`}
        value={model}
        models={models}
        loading={scanning}
        onSave={(next) =>
          onChange({
            field: "cli",
            harness,
            value: next,
            levels: modelEffortLevels(harness, findSuggestion(models, next)),
          })
        }
      />
      {model.trim() && levels.length > 0 ? (
        <CliEffortMenu
          label={`${name} ${CLI_LABELS[harness]} effort`}
          value={setting.cliEffort?.[harness] ?? null}
          levels={levels}
          onChange={(value) => onChange({ field: "cliEffort", harness, value })}
        />
      ) : null}
      {model.trim() ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Clear ${CLI_LABELS[harness]} model`}
          onClick={() => onChange({ field: "cli", harness, value: null })}
        >
          <XIcon />
        </Button>
      ) : null}
    </>
  );
}

/** One line of a tier row: the provider's name, then its field. */
const HEADLESS_ITEMS = AgentHarness.options.map((harness) => ({
  value: harness,
  label: AGENT_HARNESSES[harness].label,
}));

/**
 * The harness headless Autopilot runs on this model use, with the model set for it above. Runs that need what only
 * Claude Code can do (structured output, a review of untrusted text) still run there.
 */
function HeadlessHarness({
  name,
  value,
  onChange,
}: {
  name: string;
  value: AgentHarness | undefined;
  onChange: (value: AgentHarness) => void;
}) {
  return (
    <TierField label="Headless runs">
      <Select
        items={HEADLESS_ITEMS}
        value={value ?? "claude-code"}
        onValueChange={(next) => {
          const parsed = AgentHarness.safeParse(next);
          if (parsed.success) onChange(parsed.data);
        }}
      >
        <SelectTrigger size="sm" className="sm:w-40" aria-label={`${name} headless harness`}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {HEADLESS_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </TierField>
  );
}

function TierField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="w-24 shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
    </div>
  );
}

function T3TierModel({
  catalog,
  error,
  setting,
  canPick,
  onChange,
}: {
  catalog: T3ModelCatalog | undefined;
  error: string | null;
  setting: ModelTierSetting;
  /** T3 Code is connected now. Not, the saved model is shown but the catalog can't be read to change it. */
  canPick: boolean;
  onChange: (t3: ModelTierSetting["t3"]) => void;
}) {
  const selection = setting.t3?.selection ?? null;
  const pick = (next: T3ModelSelection) => onChange({ selection: next, label: selectionLabel(catalog!, next) });
  if (!canPick || !catalog) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">
          {(canPick ? error : null) ?? setting.t3?.label ?? (canPick ? "Loading models..." : "Not connected")}
        </span>
        {selection ? (
          <Button size="icon-xs" variant="ghost-muted" aria-label="Clear T3 Code model" onClick={() => onChange(null)}>
            <XIcon />
          </Button>
        ) : null}
      </span>
    );
  }
  return (
    <>
      <ModelPicker options={catalog} selection={selection} onChange={pick} />
      {selection ? <TraitsPicker options={catalog} selection={selection} onChange={pick} /> : null}
      {selection ? (
        <Button size="icon-xs" variant="ghost-muted" aria-label="Clear T3 Code model" onClick={() => onChange(null)}>
          <XIcon />
        </Button>
      ) : null}
    </>
  );
}
