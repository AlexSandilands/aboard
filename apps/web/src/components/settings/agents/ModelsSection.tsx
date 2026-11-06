// Settings → Agents → Models: the tiers and custom models down the left, like the providers above them, and the
// selected one's settings on the right: its description (and a custom model's name and labels), then one row per
// provider with the model it runs there, and which CLI headless runs prefer. A provider is a row, so six fit as well
// as two.
import {
  PROVIDERS,
  AgentHarness,
  MODEL_PROFILES_MAX,
  MODEL_TIERS,
  type AppSettings,
  type CliEffort,
  type ModelProfile,
  type ModelTier,
  type ModelTierSetting,
  type T3IntegrationStatus,
  type T3ModelCatalog,
  type T3ModelSelection,
} from "@repo/contracts";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { ComposerControl } from "~/components/handoff/T3LaunchPickers";
import { CliModelPicker } from "~/components/models/ModelChoicePicker";
import { PickerIcon } from "~/components/models/PickerIcon";
import { Button } from "~/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useRescanAgentModels, useUpdateSettings } from "~/state/mutations";
import { useAgentModels, useT3ModelCatalog } from "~/state/queries";
import { useSettingsNav } from "~/state/ui";
import { BlurInput } from "../BlurInput";
import {
  createProfileEdits,
  labelConflicts,
  parseLabelList,
  profileIdFor,
  saveProfileEdit,
  type ProfileEdit,
} from "../modelProfiles.logic";
import {
  createTierEdits,
  saveTierChange,
  TIER_PROVIDERS,
  tierProviderState,
  visibleTierProviders,
  type TierChange,
  type TierProvider,
} from "../modelTiers.logic";
import {
  SETTINGS_TEXT_WIDTH,
  SettingsLink,
  SettingsRow,
  SettingsSectionHeader,
  SettingsSubsection,
} from "../settingsLayout";
import {
  modelItemOfTarget,
  modelSummary,
  preferredChoices,
  sameModelItem,
  selectedModelItem,
  t3PlaceholderLabel,
  type ModelItem,
} from "./agents.logic";
import {
  CONTROL_PICKER,
  DetailBody,
  DetailHeader,
  DetailSection,
  SplitCard,
  SplitList,
  SplitListAction,
  SplitListGroup,
  SplitListItem,
} from "./SplitCard";
import { T3TierPicker } from "./T3TierPicker";

/** What the provider rows need: which providers to list, and T3 Code's catalog when it can be read. */
interface Providers {
  shown: TierProvider[];
  t3Ready: boolean;
  catalog: T3ModelCatalog | undefined;
  catalogError: string | null;
}

const providerLabel = (provider: TierProvider) => TIER_PROVIDERS.find((p) => p.provider === provider)!.label;
const providerIcon = (provider: TierProvider) =>
  provider === "t3" ? ({ kind: "t3code" } as const) : ({ kind: "harness", harness: provider } as const);

const DESCRIPTION_INFO =
  "Prompts copied from a task name the tier by this, so an agent reading one knows what to start on, e.g. “Sonnet, medium”. Empty: T3 Code's model for the tier, when one is set.";

export function ModelsSection({ settings, t3 }: { settings: AppSettings; t3: T3IntegrationStatus | undefined }) {
  const shown = visibleTierProviders(tierProviderState(settings.providers));
  const t3Ready = settings.t3TokenSet && t3?.detected === true;
  const catalog = useT3ModelCatalog(t3Ready && shown.includes("t3"));
  const providers: Providers = {
    shown,
    t3Ready,
    catalog: catalog.data,
    catalogError: catalog.error?.message ?? null,
  };
  const anyCli = shown.some((p) => p !== "t3");
  const scanned = useAgentModels(anyCli);
  const rescan = useRescanAgentModels();
  const profiles = settings.modelProfiles;

  // The item the user picked; a reload keeps the one in the URL hash, and a link to a tier or custom model (search,
  // a picker's "set in Settings") picks it, the way a folded section opens for a link to one of its rows.
  const [picked, setPicked] = useState<ModelItem | null>(() =>
    modelItemOfTarget(decodeURIComponent(window.location.hash.slice(1))),
  );
  const target = useSettingsNav((s) => s.scrollTarget);
  const [followed, setFollowed] = useState<number | null>(null);
  if (target && target.nonce !== followed) {
    setFollowed(target.nonce);
    const item = modelItemOfTarget(target.id);
    if (item) setPicked(item);
  }
  const selected = selectedModelItem(picked, profiles);

  const updateSettings = useUpdateSettings();
  const profileEdits = useRef(createProfileEdits()).current;
  const saveProfile = (edit: ProfileEdit) =>
    void saveProfileEdit(profileEdits, updateSettings.mutateAsync, profiles, edit);
  const addProfile = () => {
    const name = "New model";
    // Selected before the save returns: the list gives the new model this id.
    setPicked({ kind: "custom", id: profileIdFor(name, new Set(profiles.map((p) => p.id))) });
    saveProfile({ kind: "add", name });
  };

  return (
    <SettingsSubsection id="agents.models">
      <section className="space-y-2.5">
        <SettingsSectionHeader
          title="Models"
          headerAction={
            anyCli ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="-me-2"
                disabled={rescan.isPending || scanned.isFetching}
                onClick={() => rescan.mutate()}
                title="Ask the CLIs which models they offer"
              >
                {rescan.isPending || scanned.isFetching ? <Spinner /> : <RefreshCwIcon />}
                <span className="hidden sm:inline">Rescan models</span>
              </Button>
            ) : null
          }
        />
        <SplitCard
          list={
            <SplitList label="Tiers and custom models">
              <SplitListGroup id="agents.models.tiers.list">
                {MODEL_TIERS.map(({ value, label }) => {
                  const item: ModelItem = { kind: "tier", tier: value };
                  return (
                    <SplitListItem
                      key={value}
                      id={`agents.models.tiers.${value}`}
                      icon={<PickerIcon icon={{ kind: "tier" }} className="text-muted-foreground" />}
                      title={`${label} tier`}
                      subtitle={modelSummary(settings.modelTiers[value], shown)}
                      selected={sameModelItem(item, selected)}
                      onSelect={() => setPicked(item)}
                    />
                  );
                })}
              </SplitListGroup>
              <SplitListGroup id="agents.models.custom.list" label="Custom models">
                {profiles.map((profile) => {
                  const item: ModelItem = { kind: "custom", id: profile.id };
                  return (
                    <SplitListItem
                      key={profile.id}
                      id={`agents.models.custom.${profile.id}`}
                      icon={<PickerIcon icon={{ kind: "custom" }} className="text-muted-foreground" />}
                      title={profile.name}
                      subtitle={profile.labels.length ? profile.labels.join(", ") : modelSummary(profile, shown)}
                      selected={sameModelItem(item, selected)}
                      onSelect={() => setPicked(item)}
                    />
                  );
                })}
                <SplitListAction
                  icon={<PlusIcon className="size-4 shrink-0" />}
                  label="Add model"
                  disabled={profiles.length >= MODEL_PROFILES_MAX}
                  onClick={addProfile}
                />
              </SplitListGroup>
            </SplitList>
          }
        >
          {selected.kind === "tier" ? (
            // Keyed per item, so a field left mid-edit doesn't carry its draft into the next item's field.
            <TierDetail key={selected.tier} tier={selected.tier} settings={settings} providers={providers} />
          ) : (
            <CustomDetail
              key={selected.id}
              profile={profiles.find((p) => p.id === selected.id)!}
              profiles={profiles}
              providers={providers}
              save={saveProfile}
            />
          )}
        </SplitCard>
      </section>
    </SettingsSubsection>
  );
}

function TierDetail({ tier, settings, providers }: { tier: ModelTier; settings: AppSettings; providers: Providers }) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createTierEdits()).current;
  const { label, description } = MODEL_TIERS.find((t) => t.value === tier)!;
  const setting = settings.modelTiers[tier];
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);
  return (
    <DetailBody>
      <DetailHeader
        icon={<PickerIcon icon={{ kind: "tier" }} className="size-6 text-muted-foreground" />}
        title={`${label} tier`}
        subtitle={description}
      />
      <DetailSection title="Tier">
        <SettingsRow
          title="Description"
          description="How prompts copied from a task name this tier."
          info={DESCRIPTION_INFO}
          control={
            <BlurInput
              size="sm"
              className={cn("w-full", SETTINGS_TEXT_WIDTH)}
              aria-label={`${label} tier description`}
              placeholder={setting.t3?.label ?? "e.g. Sonnet, medium"}
              value={setting.description ?? ""}
              onSave={(next) => save({ field: "description", value: next.trim() || null })}
            />
          }
        />
      </DetailSection>
      <ModelRows name={`${label} tier`} setting={setting} providers={providers} onChange={save} />
    </DetailBody>
  );
}

function CustomDetail({
  profile,
  profiles,
  providers,
  save,
}: {
  profile: ModelProfile;
  profiles: readonly ModelProfile[];
  providers: Providers;
  save: (edit: ProfileEdit) => void;
}) {
  const index = profiles.findIndex((p) => p.id === profile.id);
  const change = (next: Extract<ProfileEdit, { kind: "change" }>["change"]) =>
    save({ kind: "change", id: profile.id, change: next });
  const conflicts = labelConflicts(profiles).filter((c) => profile.labels.includes(c.label));
  return (
    <DetailBody>
      <DetailHeader
        icon={<PickerIcon icon={{ kind: "custom" }} className="size-6 text-muted-foreground" />}
        title={profile.name}
        subtitle={
          profile.labels.length
            ? `Tasks labelled ${profile.labels.join(", ")} run on it, whatever their tier.`
            : "Picked by a task label, for an operation, or in an automation."
        }
        actions={
          <>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Move ${profile.name} up`}
              title="Move up"
              disabled={index <= 0}
              onClick={() => save({ kind: "move", id: profile.id, delta: -1 })}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`Move ${profile.name} down`}
              title="Move down"
              disabled={index < 0 || index === profiles.length - 1}
              onClick={() => save({ kind: "move", id: profile.id, delta: 1 })}
            >
              <ArrowDownIcon />
            </Button>
            <Button size="xs" variant="ghost-destructive" onClick={() => save({ kind: "remove", id: profile.id })}>
              Delete
            </Button>
          </>
        }
      />
      <DetailSection title="Model">
        <SettingsRow
          title="Name"
          control={
            <BlurInput
              size="sm"
              className={cn("w-full", SETTINGS_TEXT_WIDTH)}
              aria-label="Model name"
              value={profile.name}
              onSave={(next) => change({ field: "name", value: next })}
            />
          }
        />
        <SettingsRow
          title="Labels"
          description="Tasks carrying one run on this model."
          info="Comma-separated, each normalised like a task label. When two custom models claim a label, the one higher in the list wins."
          status={
            conflicts.length ? (
              <span className="text-warning-foreground">
                {conflicts
                  .map(
                    ({ label, winner, shadowed }) =>
                      `${label} is also on ${[winner, ...shadowed].filter((n) => n !== profile.name).join(" and ")}: ${winner} wins.`,
                  )
                  .join(" ")}
              </span>
            ) : null
          }
          control={
            <BlurInput
              size="sm"
              className={cn("w-full", SETTINGS_TEXT_WIDTH)}
              aria-label={`${profile.name} labels`}
              placeholder="e.g. codex61, fast-lane"
              value={profile.labels.join(", ")}
              onSave={(next) => change({ field: "labels", value: parseLabelList(next) })}
            />
          }
        />
        <SettingsRow
          title="Description"
          description="How prompts copied from a task name this model."
          info={DESCRIPTION_INFO}
          control={
            <BlurInput
              size="sm"
              className={cn("w-full", SETTINGS_TEXT_WIDTH)}
              aria-label={`${profile.name} description`}
              placeholder={profile.t3?.label ?? "e.g. Codex, high"}
              value={profile.description ?? ""}
              onSave={(next) => change({ field: "description", value: next.trim() || null })}
            />
          }
        />
      </DetailSection>
      <ModelRows name={profile.name} setting={profile} providers={providers} onChange={change} />
    </DetailBody>
  );
}

/**
 * One row per provider with the model a session or run on it starts on for this tier or custom model (its default
 * when none), and below them which CLI headless runs prefer, once there is a choice.
 */
function ModelRows({
  name,
  setting,
  providers,
  onChange,
}: {
  name: string;
  setting: ModelTierSetting;
  providers: Providers;
  onChange: (change: TierChange) => void;
}) {
  const choices = preferredChoices(providers.shown);
  const preferred = setting.provider && choices.includes(setting.provider) ? setting.provider : null;
  return (
    <>
      <DetailSection title="Runs on">
        {providers.shown.map((provider) => (
          <SettingsRow
            key={provider}
            title={
              <span className="flex items-center gap-2">
                <PickerIcon icon={providerIcon(provider)} />
                {providerLabel(provider)}
              </span>
            }
            status={
              provider === "t3" && !providers.t3Ready ? (
                <span>
                  <SettingsLink to="agents.providers.t3-code.pairing">Connect T3 Code</SettingsLink> to pick its models.
                </span>
              ) : null
            }
            control={
              provider === "t3" ? (
                <T3Control name={name} setting={setting} providers={providers} onChange={onChange} />
              ) : (
                <CliModelPicker
                  harness={provider}
                  model={setting.cli?.[provider] ?? ""}
                  effort={setting.cliEffort?.[provider] ?? null}
                  defaultLabel="Default model"
                  ariaLabel={`${name} ${PROVIDERS[provider].label} model`}
                  size="sm"
                  className={CONTROL_PICKER}
                  onModel={(value: string | null, levels: readonly CliEffort[]) =>
                    onChange({ field: "cli", harness: provider, value, levels })
                  }
                  onEffort={(value) => onChange({ field: "cliEffort", harness: provider, value })}
                />
              )
            }
          />
        ))}
      </DetailSection>
      {choices.length > 1 ? (
        <DetailSection title="Headless runs">
          <SettingsRow
            title="Preferred provider"
            description="Tried first by Autopilot and the reviewer; else the first that can."
            info="A headless run (an Autopilot task, the board reviewer, PR review, the digest) needs a CLI. It runs on this one when it can do what the run needs, else on the first provider in your list that can."
            control={
              <Select
                items={choices.map((harness) => ({ value: harness, label: PROVIDERS[harness].label }))}
                value={preferred}
                onValueChange={(value) => {
                  const harness = AgentHarness.safeParse(value);
                  if (harness.success) onChange({ field: "headless", value: harness.data });
                }}
              >
                <SelectTrigger size="sm" className={cn("w-full min-w-0", SETTINGS_TEXT_WIDTH)}>
                  <SelectValue placeholder="First that can" />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {choices.map((harness) => (
                    <SelectItem key={harness} value={harness}>
                      <span className="flex items-center gap-2">
                        <PickerIcon icon={{ kind: "harness", harness }} />
                        {PROVIDERS[harness].label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </DetailSection>
      ) : null}
    </>
  );
}

/** T3 Code's picker, or in its place and shape what stands in while its catalog can't be read. */
function T3Control({
  name,
  setting,
  providers,
  onChange,
}: {
  name: string;
  setting: ModelTierSetting;
  providers: Providers;
  onChange: (change: TierChange) => void;
}) {
  const selection = setting.t3?.selection ?? null;
  const { catalog } = providers;
  if (providers.t3Ready && catalog) {
    return (
      <T3TierPicker
        catalog={catalog}
        selection={selection}
        savedLabel={setting.t3?.label ?? null}
        ariaLabel={`${name} T3 Code model`}
        className={CONTROL_PICKER}
        onChange={(next: T3ModelSelection | null) =>
          onChange({ field: "t3", value: next ? { selection: next, label: selectionLabel(catalog, next) } : null })
        }
      />
    );
  }
  const label = t3PlaceholderLabel(providers.t3Ready, providers.catalogError, setting.t3?.label);
  const placeholder = (
    <ComposerControl
      size="sm"
      disabled
      aria-label={`${name} T3 Code model, ${label}`}
      className={cn(CONTROL_PICKER, "text-muted-foreground")}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <PickerIcon icon={{ kind: "t3code" }} />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </span>
      <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />
    </ComposerControl>
  );
  // The picker needs T3 Code's catalog, but clearing a saved model doesn't, so that stays possible while it's away.
  if (!setting.t3) return placeholder;
  return (
    <span className={cn("flex w-full items-center gap-1", "@min-[32rem]/settings-row:w-72")}>
      <span className="min-w-0 flex-1 [&>*]:w-full">{placeholder}</span>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Reset ${name} T3 Code model to the default`}
        title="Use T3 Code's default"
        onClick={() => onChange({ field: "t3", value: null })}
      >
        <XIcon />
      </Button>
    </span>
  );
}
