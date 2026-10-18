import {
  MODEL_TIERS,
  type AgentHarness,
  type AppSettings,
  type ModelTier,
  type T3IntegrationStatus,
  type T3ModelCatalog,
  type T3ModelSelection,
  type ModelTierSetting,
} from "@repo/contracts";
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ModelPicker, TraitsPicker } from "~/components/handoff/T3LaunchPickers";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { Button } from "~/components/ui/button";
import { useUpdateSettings } from "~/state/mutations";
import { useAgentIntegrations, useT3ModelCatalog } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import { tierUpdate, visibleTierProviders, type TierChange, type TierProvider } from "./modelTiers.logic";
import { SettingsLink, SettingsRow, SettingsSection } from "./settingsLayout";

const CLI_PLACEHOLDERS: Record<AgentHarness, string> = {
  "claude-code": "e.g. sonnet",
  "copilot-cli": "e.g. gpt-5.4",
};

const CLI_LABELS: Record<AgentHarness, string> = { "claude-code": "Claude Code", "copilot-cli": "Copilot CLI" };

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
  const shown = new Set<TierProvider>(visibleTierProviders(settings.modelTiers, { t3Ready, cliFound }));
  const save = (tier: ModelTier, change: TierChange) => updateSettings.mutate(tierUpdate(settings, tier, change));

  return (
    <SettingsSection id="models.tiers.list" title="Model tiers">
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
              {(["claude-code", "copilot-cli"] as const).map((harness) =>
                shown.has(harness) ? (
                  <TierField key={harness} label={CLI_LABELS[harness]}>
                    <BlurInput
                      size="sm"
                      className="w-full sm:max-w-sm"
                      aria-label={`${label} tier ${CLI_LABELS[harness]} model`}
                      placeholder={CLI_PLACEHOLDERS[harness]}
                      value={setting.cli?.[harness] ?? ""}
                      onSave={(next) => save(tier, { field: "cli", harness, value: next.trim() || null })}
                    />
                  </TierField>
                ) : null,
              )}
            </div>
          </SettingsRow>
        );
      })}
      {shown.size < 3 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground/80 sm:px-4">
          A provider's model shows here once it is set up. See{" "}
          <SettingsLink to="integrations">Integrations</SettingsLink>.
        </p>
      ) : null}
    </SettingsSection>
  );
}

/** One line of a tier row: the provider's name, then its field. */
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
