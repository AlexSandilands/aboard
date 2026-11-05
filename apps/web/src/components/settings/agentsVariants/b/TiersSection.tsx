import { MODEL_TIERS, type AppSettings, type ModelTier } from "@repo/contracts";
import { useRef } from "react";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { BlurInput } from "../../BlurInput";
import { createTierEdits, saveTierChange, type TierChange } from "../../modelTiers.logic";
import {
  SETTINGS_NUMBER_WIDTH,
  SETTINGS_TEXT_WIDTH,
  SettingsGroup,
  SettingsRow,
  SettingsSectionHeader,
} from "../../settingsLayout";
import { preferredChoices } from "./b.logic";
import { PreferredSelect } from "./fields";

/**
 * Tiers: what isn't per provider about each tier, a row each. Its description (how prompts name it) and the provider
 * headless runs on it try first. What each provider runs for the tier is in that provider's pane under Providers, so
 * this card stays three rows however many providers there are.
 */
export function TiersSection({ settings }: { settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createTierEdits()).current;
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (tier: ModelTier, change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);
  // The select column shows only while a CLI provider is on (T3 Code can't run headless, so there is nothing to
  // prefer), or a tier still names one that isn't.
  const withSelect =
    preferredChoices(settings.providers, undefined).length > 0 ||
    MODEL_TIERS.some(({ value }) => !!settings.modelTiers[value].provider);
  return (
    <section id="agents.models.tiers.list" className="scroll-mt-4 space-y-2.5">
      <SettingsSectionHeader title="Tiers" />
      <SettingsGroup className="@container/tiers">
        <div
          aria-hidden
          className="hidden items-center justify-end gap-2 px-3 pt-2.5 pb-1.5 text-2xs font-medium text-muted-foreground sm:px-4 @min-[32rem]/tiers:flex"
        >
          <span className="w-56">Description</span>
          {withSelect ? <span className="w-36">Preferred provider</span> : null}
        </div>
        {MODEL_TIERS.map(({ value: tier, label, description }) => {
          const setting = settings.modelTiers[tier];
          const choices = preferredChoices(settings.providers, setting.provider);
          return (
            <SettingsRow
              key={tier}
              id={`agents.models.tiers.${tier}`}
              title={label}
              description={description}
              info={
                <>
                  <p>
                    The description is how prompts copied from a task name the tier, so an agent knows what to start on;
                    empty, the T3 Code model's name stands in.
                  </p>
                  <p className="mt-2">
                    Headless runs on this tier use the preferred provider when it can do what the run needs, else the
                    first provider added that can. The model each provider starts on for the tier is in its pane under
                    Providers.
                  </p>
                </>
              }
              control={
                <div className="flex w-full min-w-0 flex-wrap items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:flex-nowrap">
                  <BlurInput
                    size="sm"
                    className={cn("w-full", SETTINGS_TEXT_WIDTH)}
                    aria-label={`${label} tier description`}
                    placeholder={setting.t3?.label ?? "e.g. Sonnet, medium"}
                    value={setting.description ?? ""}
                    onSave={(next) => save(tier, { field: "description", value: next.trim() || null })}
                  />
                  {withSelect ? (
                    <div className={cn("w-full", SETTINGS_NUMBER_WIDTH)}>
                      {choices.length > 0 ? (
                        <PreferredSelect
                          choices={choices}
                          value={setting.provider}
                          name={`${label} tier`}
                          onChange={(harness) => save(tier, { field: "headless", value: harness })}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              }
            />
          );
        })}
      </SettingsGroup>
    </section>
  );
}
