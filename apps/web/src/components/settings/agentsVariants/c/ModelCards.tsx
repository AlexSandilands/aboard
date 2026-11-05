// Design C's Models: a card per tier and per custom model. The header holds what the card is (name, description,
// labels); inside, one aligned row per provider switched on, so more providers only add rows.
import {
  AGENT_HARNESSES,
  type AgentHarness,
  MODEL_PROFILES_MAX,
  MODEL_TIERS,
  type AppSettings,
  type CliEffort,
  type ModelProfile,
  type ModelTier,
  type ModelTierSetting,
  type T3ModelCatalog,
  type T3ModelSelection,
} from "@repo/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRef, type ReactNode } from "react";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { CliModelPicker } from "~/components/models/ModelChoicePicker";
import { PickerIcon } from "~/components/models/PickerIcon";
import { T3ModelPicker } from "~/components/models/T3ModelPicker";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useRescanAgentModels, useUpdateSettings } from "~/state/mutations";
import { useAgentModels, useT3ModelCatalog } from "~/state/queries";
import { BlurInput } from "../../BlurInput";
import {
  createProfileEdits,
  labelConflicts,
  parseLabelList,
  saveProfileEdit,
  type ProfileEdit,
} from "../../modelProfiles.logic";
import { createTierEdits, saveTierChange, type TierChange } from "../../modelTiers.logic";
import { SettingsGroup, SettingsLink, StatusDot } from "../../settingsLayout";
import { useOpenSettings } from "../../settingsNavigation";
import { INLINE_FIELD, PICKER_FIELD, SectionHeading } from "./parts";
import { canPrefer, type CardRow } from "./tierCards.logic";

export interface CardContext {
  rows: CardRow[];
  catalog: T3ModelCatalog | undefined;
  catalogError: string | null;
}

/** The catalog T3 Code's rows pick from, fetched only while one of them can use it. */
export function useCardContext(rows: CardRow[]): CardContext {
  const t3Ready = rows.some((r) => r.provider === "t3" && r.state === "ready");
  const catalog = useT3ModelCatalog(t3Ready);
  return { rows, catalog: catalog.data, catalogError: catalog.error?.message ?? null };
}

// One column template for every row of every card: the provider, the picker at a fixed width, then one icon slot (the
// preferred star, or T3 Code's clear). Below 30rem the picker drops under the name.
const ROW =
  "grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-x-3 gap-y-1.5 px-3 py-1.5 sm:px-4 @min-[30rem]/card:grid-cols-[minmax(0,1fr)_15rem_1.75rem]";
const ROW_FIELD =
  "col-span-2 row-start-2 @min-[30rem]/card:col-span-1 @min-[30rem]/card:col-start-2 @min-[30rem]/card:row-start-1";
const ROW_SLOT = "col-start-2 row-start-1 flex justify-center @min-[30rem]/card:col-start-3";

/** A card: its header, then its rows in one block (no rules between them, so the card reads as one thing). */
function ModelCard({
  id,
  label,
  header,
  children,
}: {
  id: string;
  label: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsGroup id={id} role="group" aria-label={label} className="@container/card scroll-mt-4">
      <div className="flex min-h-11 items-center gap-2 px-3 py-2 sm:px-4">{header}</div>
      <div className="py-1.5">{children}</div>
    </SettingsGroup>
  );
}

export function TiersSection({ settings, ctx }: { settings: AppSettings; ctx: CardContext }) {
  const updateSettings = useUpdateSettings();
  const anyCli = ctx.rows.some((r) => canPrefer(r.provider));
  const scanned = useAgentModels(anyCli);
  const rescan = useRescanAgentModels();
  const edits = useRef(createTierEdits()).current;
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (tier: ModelTier, change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);
  return (
    <section id="agents.models.tiers.list" className="scroll-mt-4 space-y-2.5">
      <SectionHeading
        title="Tiers"
        info={
          <>
            <p>
              Planning agents suggest a tier for each task. A tier's description is named in prompts copied from a task;
              each row is the model a session on that provider starts on (Default model leaves the provider's own).
            </p>
            <p className="mt-2">
              The star marks the provider headless runs on the tier try first. Without one, or when it can't do the job,
              the first able provider in Providers runs it.
            </p>
          </>
        }
        action={
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
              Rescan models
            </Button>
          ) : null
        }
      />
      <div className="space-y-3">
        {MODEL_TIERS.map(({ value: tier, label }) => {
          const setting = settings.modelTiers[tier];
          return (
            <ModelCard
              key={tier}
              id={`agents.models.tiers.${tier}`}
              label={`${label} tier`}
              header={
                <>
                  <h3 className="w-40 shrink-0 text-sm font-medium text-foreground">{label}</h3>
                  <BlurInput
                    unstyled
                    size="sm"
                    className={cn(INLINE_FIELD, "-ms-2.5 flex-1 text-xs text-muted-foreground")}
                    aria-label={`${label} tier description`}
                    placeholder={setting.t3?.label ?? "Add a description for prompts, e.g. Sonnet, medium"}
                    value={setting.description ?? ""}
                    onSave={(next) => save(tier, { field: "description", value: next.trim() || null })}
                  />
                </>
              }
            >
              <ProviderRows
                name={`${label} tier`}
                setting={setting}
                ctx={ctx}
                onChange={(change) => save(tier, change)}
              />
            </ModelCard>
          );
        })}
      </div>
    </section>
  );
}

/** A card's rows: one per provider switched on, in the Providers order. */
function ProviderRows({
  name,
  setting,
  ctx,
  onChange,
}: {
  name: string;
  setting: ModelTierSetting;
  ctx: CardContext;
  onChange: (change: TierChange) => void;
}) {
  return (
    <div role="radiogroup" aria-label={`${name}: preferred provider for headless runs`}>
      {ctx.rows.map((row) => (
        <div key={row.provider} className={ROW}>
          <ProviderName row={row} />
          {row.provider === "t3" ? (
            <T3Cells
              name={name}
              row={row}
              setting={setting}
              ctx={ctx}
              onChange={(t3) => onChange({ field: "t3", value: t3 })}
            />
          ) : (
            <CliCells name={name} row={row} harness={row.provider} setting={setting} onChange={onChange} />
          )}
        </div>
      ))}
    </div>
  );
}

/** A CLI's picker (its models, a typed one, or Default model) and the tier's preferred star. */
function CliCells({
  name,
  row,
  harness,
  setting,
  onChange,
}: {
  name: string;
  row: CardRow;
  harness: AgentHarness;
  setting: ModelTierSetting;
  onChange: (change: TierChange) => void;
}) {
  return (
    <>
      <div className={ROW_FIELD}>
        <CliModelPicker
          harness={harness}
          model={setting.cli?.[harness] ?? ""}
          effort={setting.cliEffort?.[harness] ?? null}
          defaultLabel="Default model"
          ariaLabel={`${name} ${AGENT_HARNESSES[harness].label} model`}
          className={PICKER_FIELD}
          onModel={(value: string | null, levels: readonly CliEffort[]) =>
            onChange({ field: "cli", harness, value, levels })
          }
          onEffort={(value) => onChange({ field: "cliEffort", harness, value })}
        />
      </div>
      <div className={ROW_SLOT}>
        <PreferredStar
          name={`${name} ${row.label}`}
          checked={setting.provider === harness}
          onPick={() => onChange({ field: "headless", value: harness })}
        />
      </div>
    </>
  );
}

/** The provider's mark and name, opening it on Providers; a dot says what's wrong with it, if anything. */
function ProviderName({ row }: { row: CardRow }) {
  const openSettings = useOpenSettings();
  return (
    <button
      type="button"
      className={cn(
        "flex h-7 w-fit min-w-0 cursor-pointer items-center gap-2.5 rounded-md text-left text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        row.state === "offline" ? "text-muted-foreground" : "text-foreground/90",
      )}
      title={`Open ${row.label} in Providers`}
      onClick={() => openSettings(row.target)}
    >
      <PickerIcon
        icon={row.provider === "t3" ? { kind: "t3code" } : { kind: "harness", harness: row.provider }}
        className={cn(row.state === "offline" && "opacity-50 grayscale")}
      />
      <span className="truncate">{row.label}</span>
      {row.problem && row.state === "ready" ? <StatusDot tone="warning" label={row.problem} /> : null}
    </button>
  );
}

/**
 * The tier's preferred provider for headless runs: a star per CLI row, filled on the one picked. It works as a radio
 * group (one per card); picking another moves it.
 */
function PreferredStar({ name, checked, onPick }: { name: string; checked: boolean; onPick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            role="radio"
            aria-checked={checked}
            aria-label={`${name}: preferred for headless runs`}
            className={cn(!checked && "text-muted-foreground/45")}
            onClick={onPick}
          />
        }
      >
        <StarIcon className={cn(checked && "fill-warning text-warning")} />
      </TooltipTrigger>
      <TooltipPopup side="top">{checked ? "Preferred for headless runs" : "Prefer for headless runs"}</TooltipPopup>
    </Tooltip>
  );
}

/** T3 Code's picker and its clear, or while it can't be reached, a muted field saying why with the fix beside it. */
function T3Cells({
  name,
  row,
  setting,
  ctx,
  onChange,
}: {
  name: string;
  row: CardRow;
  setting: ModelTierSetting;
  ctx: CardContext;
  onChange: (t3: ModelTierSetting["t3"]) => void;
}) {
  const selection = setting.t3?.selection ?? null;
  const { catalog } = ctx;
  const clear = selection ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Clear ${name} T3 Code model`}
            onClick={() => onChange(null)}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="top">Back to T3 Code's default</TooltipPopup>
    </Tooltip>
  ) : null;
  if (row.state === "offline" || !catalog) {
    const text = row.state === "offline" ? row.problem : (ctx.catalogError ?? "Loading models…");
    return (
      <>
        <div
          className={cn(
            ROW_FIELD,
            "flex h-7 min-w-0 items-center justify-between gap-2 rounded-lg border border-dashed border-border px-2.5 text-xs text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate" title={setting.t3?.label ?? undefined}>
            {setting.t3?.label ? `${setting.t3.label} · ` : null}
            {text}
          </span>
          {row.state === "offline" ? (
            <span className="shrink-0">
              <SettingsLink to={row.target}>{row.problem === "Not connected" ? "Connect" : "Fix"}</SettingsLink>
            </span>
          ) : null}
        </div>
        <div className={ROW_SLOT}>{clear}</div>
      </>
    );
  }
  return (
    <>
      <div className={ROW_FIELD}>
        <T3ModelPicker
          catalog={catalog}
          selection={selection}
          ariaLabel={`${name} T3 Code model`}
          className={PICKER_FIELD}
          onChange={(next: T3ModelSelection) => onChange({ selection: next, label: selectionLabel(catalog, next) })}
        />
      </div>
      <div className={ROW_SLOT}>{clear}</div>
    </>
  );
}

/**
 * Named models beyond the tiers, each a tier's card with its name, description and labels in the header: tasks that
 * carry one of its labels run on it whatever their tier, and any model picker can pick it.
 */
export function CustomModelsSection({ profiles, ctx }: { profiles: readonly ModelProfile[]; ctx: CardContext }) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createProfileEdits()).current;
  const save = (edit: ProfileEdit) => void saveProfileEdit(edits, updateSettings.mutateAsync, profiles, edit);
  const change = (id: string, next: Extract<ProfileEdit, { kind: "change" }>["change"]) =>
    save({ kind: "change", id, change: next });
  const conflicts = labelConflicts(profiles);
  return (
    <section id="agents.models.custom.list" className="scroll-mt-4 space-y-2.5">
      <SectionHeading
        title="Custom models"
        info={
          <>
            <p>
              A model of your own beyond the tiers. Tasks that carry one of its labels run on it whatever their tier,
              and any model picker (an operation, an automation) can pick it.
            </p>
            <p className="mt-2">When two custom models share a label, the first in the list wins.</p>
          </>
        }
        action={
          <Button
            size="xs"
            variant="ghost-muted"
            className="-me-2"
            disabled={profiles.length >= MODEL_PROFILES_MAX}
            onClick={() => save({ kind: "add", name: "New model" })}
          >
            <PlusIcon />
            Add model
          </Button>
        }
      />
      {profiles.length === 0 ? (
        <SettingsGroup>
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            None yet. A custom model runs the tasks labelled for it, say <span className="font-mono">codex61</span>.
          </p>
        </SettingsGroup>
      ) : (
        <div className="space-y-3">
          {profiles.map((profile, index) => (
            <ModelCard
              key={profile.id}
              id={`agents.models.custom.${profile.id}`}
              label={profile.name}
              header={
                <>
                  <BlurInput
                    unstyled
                    size="sm"
                    className={cn(INLINE_FIELD, "-ms-2.5 w-[10.625rem] shrink-0 text-sm font-medium text-foreground")}
                    aria-label="Model name"
                    value={profile.name}
                    onSave={(next) => change(profile.id, { field: "name", value: next })}
                  />
                  <BlurInput
                    unstyled
                    size="sm"
                    className={cn(INLINE_FIELD, "flex-1 text-xs text-muted-foreground")}
                    aria-label={`${profile.name} description`}
                    placeholder={profile.t3?.label ?? "Add a description, e.g. Codex, high"}
                    value={profile.description ?? ""}
                    onSave={(next) => change(profile.id, { field: "description", value: next.trim() || null })}
                  />
                  <div className="-me-1.5 flex shrink-0 items-center">
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
                      variant="ghost-destructive"
                      aria-label={`Remove ${profile.name}`}
                      onClick={() => save({ kind: "remove", id: profile.id })}
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                </>
              }
            >
              <div className={ROW}>
                <span className="flex h-7 items-center gap-2.5 text-sm text-muted-foreground">
                  <TagIcon aria-hidden className="size-4 shrink-0" />
                  Labels
                </span>
                <div className={ROW_FIELD}>
                  <BlurInput
                    size="sm"
                    className="w-full"
                    aria-label={`${profile.name} labels`}
                    placeholder="e.g. codex61, fast"
                    value={profile.labels.join(", ")}
                    onSave={(next) => change(profile.id, { field: "labels", value: parseLabelList(next) })}
                  />
                </div>
              </div>
              <ProviderRows
                name={profile.name}
                setting={profile}
                ctx={ctx}
                onChange={(next) => change(profile.id, next)}
              />
            </ModelCard>
          ))}
        </div>
      )}
      {conflicts.map(({ label, winner, shadowed }) => (
        <p key={label} className="px-3 text-xs text-warning-foreground sm:px-4">
          Label {label} is on {[winner, ...shadowed].join(" and ")}: {winner} wins, being first.
        </p>
      ))}
    </section>
  );
}
