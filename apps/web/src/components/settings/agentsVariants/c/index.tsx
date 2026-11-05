import { useIntegrationsStatus, useProviders } from "~/state/queries";
import { SettingsGroup, SettingsLink, SettingsSubsection } from "../../settingsLayout";
import type { AgentsVariant } from "../types";
import { CustomModelsSection, TiersSection, useCardContext } from "./ModelCards";
import { OperationsPanel } from "./OperationsPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { cardRows } from "./tierCards.logic";

/**
 * Design C, tier cards: Providers as master-detail; then a card per tier and per custom model, each holding one aligned
 * row per provider switched on (more providers add rows, never columns); then the operations. Until a provider is
 * added, the page is one empty state.
 */
export const cVariant: AgentsVariant = {
  id: "c",
  label: "C · Tier cards",
  author: "Opus 5.5",
  Page: function TierCardsAgentsPage({ settings }) {
    const providers = useProviders();
    const t3 = useIntegrationsStatus().data?.t3;
    const rows = cardRows(settings.providers, (id) => providers.data?.providers.find((p) => p.id === id), {
      tokenSet: settings.t3TokenSet,
      detected: t3?.detected,
    });
    const ctx = useCardContext(rows);
    const added = settings.providers.length > 0;
    return (
      <>
        <SettingsSubsection id="agents.providers">
          <ProvidersPanel settings={settings} />
        </SettingsSubsection>
        {added ? (
          <>
            <SettingsSubsection id="agents.models">
              {rows.length === 0 ? (
                <SettingsGroup>
                  <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
                    Every provider is switched off. Switch one on in{" "}
                    <SettingsLink to="agents.providers">Providers</SettingsLink> to set its models.
                  </p>
                </SettingsGroup>
              ) : (
                <>
                  <TiersSection settings={settings} ctx={ctx} />
                  <CustomModelsSection profiles={settings.modelProfiles} ctx={ctx} />
                </>
              )}
            </SettingsSubsection>
            <SettingsSubsection id="agents.operations">
              {rows.length === 0 ? null : <OperationsPanel settings={settings} />}
            </SettingsSubsection>
          </>
        ) : null}
      </>
    );
  },
};
