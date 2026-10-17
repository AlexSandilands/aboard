import {
  MODEL_TIERS,
  type AppSettings,
  type ModelTier,
  type ModelTierSetting,
  type T3IntegrationStatus,
  type T3ModelCatalog,
  type T3ModelSelection,
} from "@repo/contracts";
import { XIcon } from "lucide-react";
import { ModelPicker, TraitsPicker } from "~/components/handoff/T3LaunchPickers";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { Button } from "~/components/ui/button";
import { useUpdateSettings } from "~/state/mutations";
import { useT3ModelCatalog } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * What each suggested model tier means: a description named in copied prompts for any harness, and a T3 Code
 * model that "New T3 Code thread" starts on. Planning agents pick the tier; the user picks the models here.
 */
export function ModelTiersSection({ settings, t3 }: { settings: AppSettings; t3: T3IntegrationStatus | undefined }) {
  const updateSettings = useUpdateSettings();
  const t3Ready = settings.t3TokenSet && t3?.detected === true;
  const catalog = useT3ModelCatalog(t3Ready);
  const save = (tier: ModelTier, patch: Partial<ModelTierSetting>) =>
    // Only this tier is sent, so quick edits to two tiers can't overwrite each other.
    updateSettings.mutate({ modelTiers: { [tier]: { ...settings.modelTiers[tier], ...patch } } });

  return (
    <SettingsSection id="tasks.models.tiers" title="Model tiers">
      {MODEL_TIERS.map(({ value: tier, label, description }) => (
        <SettingsRow
          key={tier}
          id={`tasks.models.${tier}`}
          title={label}
          description={description}
          control={
            <BlurInput
              size="sm"
              className="sm:w-56"
              aria-label={`${label} tier model`}
              placeholder={settings.modelTiers[tier].t3?.label ?? "e.g. Sonnet, medium effort"}
              value={settings.modelTiers[tier].description ?? ""}
              onSave={(next) => save(tier, { description: next.trim() || null })}
            />
          }
        >
          {t3Ready ? (
            <T3TierModel
              catalog={catalog.data}
              error={catalog.error?.message ?? null}
              setting={settings.modelTiers[tier]}
              onChange={(t3Setting) => save(tier, { t3: t3Setting })}
            />
          ) : null}
        </SettingsRow>
      ))}
    </SettingsSection>
  );
}

function T3TierModel({
  catalog,
  error,
  setting,
  onChange,
}: {
  catalog: T3ModelCatalog | undefined;
  error: string | null;
  setting: ModelTierSetting;
  onChange: (t3: ModelTierSetting["t3"]) => void;
}) {
  const selection = setting.t3?.selection ?? null;
  const pick = (next: T3ModelSelection) => onChange({ selection: next, label: selectionLabel(catalog!, next) });
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="me-1 shrink-0">T3 Code model</span>
      {catalog ? (
        <>
          <ModelPicker options={catalog} selection={selection} onChange={pick} />
          {selection ? <TraitsPicker options={catalog} selection={selection} onChange={pick} /> : null}
          {selection ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Clear T3 Code model"
              onClick={() => onChange(null)}
            >
              <XIcon />
            </Button>
          ) : null}
        </>
      ) : (
        <span>{error ?? setting.t3?.label ?? "Loading models..."}</span>
      )}
    </div>
  );
}
