import { ProviderId, type AppSettings } from "@repo/contracts";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useIntegrationsStatus, useProviders, useT3ModelCatalog } from "~/state/queries";
import { tierProviderState, visibleTierProviders, type TierProvider } from "../../modelTiers.logic";
import { SettingsLink, SettingsNote, SettingsSection, SettingsSubsection } from "../../settingsLayout";
import type { AgentsVariant } from "../types";
import { CustomModelsCard } from "./CustomModelsCard";
import { OperationsCards } from "./OperationsCards";
import { providerLabel, type ModelContext } from "./parts";
import { ProvidersPanel } from "./ProvidersPanel";
import { TiersCard } from "./TiersCard";
import { activeTab, tierProviderOf } from "./variantA.logic";

/**
 * Design A, "Provider tabs": Providers as a master-detail; Tiers as a tab per provider with that provider's model for
 * each tier; custom models as folded rows that open to an editor; operations as aligned rows. With no provider added
 * the page is one card with an Add provider button.
 */
export const aVariant: AgentsVariant = {
  id: "a",
  label: "A · Provider tabs",
  author: "Opus 5.5",
  Page: function ProviderTabsPage({ settings }) {
    const [adding, setAdding] = useState(false);
    const [picked, setTab] = useState<TierProvider | null>(null);
    // Until a tab is picked, the provider open on Providers (`?provider=`) picks it, so its models are what show.
    const requested = ProviderId.safeParse(useSearch({ strict: false, select: (search) => search.provider }));
    const tab = picked ?? (requested.success ? tierProviderOf(requested.data) : null);
    const select = (id: ProviderId) => setTab(tierProviderOf(id));
    return (
      <>
        <ProvidersPanel settings={settings} adding={adding} onAddingChange={setAdding} onSelect={select} />
        {settings.providers.length > 0 ? <ModelsAndOperations settings={settings} tab={tab} onTab={setTab} /> : null}
      </>
    );
  },
};

function ModelsAndOperations({
  settings,
  tab: requested,
  onTab,
}: {
  settings: AppSettings;
  tab: TierProvider | null;
  onTab: (tab: TierProvider) => void;
}) {
  const t3 = useIntegrationsStatus().data?.t3;
  const providers = useProviders().data;
  const shown = visibleTierProviders(tierProviderState(settings.providers));
  const t3Ready = settings.t3TokenSet && t3?.detected === true;
  const catalog = useT3ModelCatalog(t3Ready && shown.includes("t3"));
  const ctx: ModelContext = { t3Ready, catalog: catalog.data, catalogError: catalog.error?.message ?? null };
  const tab = activeTab(shown, requested);

  /** Why a provider's models can't be listed, for its tab; null when they can. */
  const status = (provider: TierProvider): string | null => {
    if (provider === "t3") {
      if (!settings.t3TokenSet) return "T3 Code isn't paired, so its models can't be listed.";
      if (t3 && !t3.detected) return "T3 Code isn't running, so its models can't be listed.";
      return ctx.catalogError;
    }
    const cli = providers?.providers.find((p) => p.id === provider)?.cli;
    return cli && !cli.found ? `${providerLabel(provider)} CLI not found; type a model to use it anyway.` : null;
  };

  if (!tab) {
    // Every provider added is switched off: one line, not a page of pickers with nothing to offer.
    return (
      <>
        <SettingsSubsection id="agents.models">
          <SettingsSection title="Models">
            <SettingsNote>
              Every provider is switched off, so nothing can run. Switch one on in{" "}
              <SettingsLink to="agents.providers">Providers</SettingsLink> to choose models and operations.
            </SettingsNote>
          </SettingsSection>
        </SettingsSubsection>
        <SettingsSubsection id="agents.operations">{null}</SettingsSubsection>
      </>
    );
  }

  return (
    <>
      <SettingsSubsection id="agents.models">
        <TiersCard settings={settings} shown={shown} tab={tab} onTab={onTab} ctx={ctx} status={status} />
        <CustomModelsCard profiles={settings.modelProfiles} shown={shown} ctx={ctx} />
      </SettingsSubsection>
      <SettingsSubsection id="agents.operations">
        <OperationsCards settings={settings} />
      </SettingsSubsection>
    </>
  );
}
