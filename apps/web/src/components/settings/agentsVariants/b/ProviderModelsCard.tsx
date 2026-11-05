import { MODEL_TIERS, type AppSettings, type ModelTier } from "@repo/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useRef } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useRescanAgentModels, useUpdateSettings } from "~/state/mutations";
import { useAgentModels } from "~/state/queries";
import { createTierEdits, saveTierChange, type TierChange, type TierProvider } from "../../modelTiers.logic";
import { SettingResetButton, SettingsRow } from "../../settingsLayout";
import { providerLabel } from "./b.logic";
import { ModelField } from "./fields";

/**
 * The Models card of a provider's pane: what each tier runs on this provider, one row per tier. The rows are the
 * same for every provider, so adding a provider adds a pane, never a column. The tiers' descriptions and the
 * preferred provider per tier are on Models, which isn't per provider.
 */
export function ProviderModelsCard({ provider, settings }: { provider: TierProvider; settings: AppSettings }) {
  const updateSettings = useUpdateSettings();
  const edits = useRef(createTierEdits()).current;
  const label = providerLabel(provider);
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (tier: ModelTier, change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);
  const clear: TierChange =
    provider === "t3" ? { field: "t3", value: null } : { field: "cli", harness: provider, value: null };
  return (
    <>
      {MODEL_TIERS.map(({ value: tier, label: tierLabel, description }) => {
        const setting = settings.modelTiers[tier];
        const set = provider === "t3" ? !!setting.t3 : !!setting.cli?.[provider]?.trim();
        const preferred = provider !== "t3" && setting.provider === provider;
        return (
          <SettingsRow
            key={tier}
            title={
              preferred ? (
                <span className="flex items-center gap-2">
                  {tierLabel}
                  <Badge size="sm" variant="secondary" title="Headless runs on this tier try this provider first">
                    Preferred
                  </Badge>
                </span>
              ) : (
                tierLabel
              )
            }
            infoLabel={`More about the ${tierLabel} tier on ${label}`}
            info={
              <>
                <p>{description}</p>
                <p className="mt-2 text-muted-foreground">
                  The model a session or run on {label} starts on when a task suggests this tier. The default is
                  whatever {label} is set to use.
                </p>
              </>
            }
            description={setting.description?.trim() || undefined}
            resetAction={
              set ? (
                <SettingResetButton
                  label={`${tierLabel} tier model on ${label}`}
                  to={`${label}'s default`}
                  onClick={() => save(tier, clear)}
                />
              ) : undefined
            }
            control={
              <ModelField
                provider={provider}
                name={`${tierLabel} tier`}
                setting={setting}
                onChange={(change) => save(tier, change)}
              />
            }
          />
        );
      })}
    </>
  );
}

/** Asks the CLIs which models they offer again; the header action of a CLI provider's Models card. */
export function RescanModelsButton() {
  const scanned = useAgentModels(true);
  const rescan = useRescanAgentModels();
  const busy = rescan.isPending || scanned.isFetching;
  return (
    <Button size="xs" variant="ghost-muted" className="-me-2" disabled={busy} onClick={() => rescan.mutate()}>
      {busy ? <Spinner /> : <RefreshCwIcon />}
      Rescan
    </Button>
  );
}
