import { activeProviderIds, type AppSettings, type T3IntegrationStatus } from "@repo/contracts";
import { memo } from "react";
import { useIntegrationsStatus, useSettingsSelect } from "~/state/queries";
import { selectProviderEditorSettings } from "../ProviderEditors";
import { ModelsSection, selectModelsSettings } from "./ModelsSection";
import { OperationsSection } from "./OperationsSection";
import { ProvidersSection } from "./ProvidersSection";

/**
 * Settings → Agents: two split cards of the same shape, Providers and Models, then the Operations rows. Everything that
 * comes in numbers (providers, tiers, custom models) is a row in a list with the selected one's settings beside it, so
 * the page is the same shape with one provider or eight. Before a provider is added there is one empty state and
 * nothing else.
 */
export function AgentsPage({ settings }: { settings: AppSettings }) {
  const t3 = useIntegrationsStatus().data?.t3;
  const any = settings.providers.length > 0;
  return (
    <>
      <Providers />
      {any ? <Models t3={t3} /> : null}
      {any ? <OperationsSection blocked={activeProviderIds(settings).length === 0} /> : null}
    </>
  );
}

// Each section reads only its own settings, so a pick in one doesn't re-render the others (the page re-renders on
// every change).
const Providers = memo(function Providers() {
  const settings = useSettingsSelect(selectProviderEditorSettings);
  return settings ? <ProvidersSection settings={settings} /> : null;
});

const Models = memo(function Models({ t3 }: { t3: T3IntegrationStatus | undefined }) {
  const settings = useSettingsSelect(selectModelsSettings);
  return settings ? <ModelsSection settings={settings} t3={t3} /> : null;
});
