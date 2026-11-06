import { useIntegrationsStatus } from "~/state/queries";
import type { AgentsVariant } from "../types";
import { ModelsSection } from "./ModelsSection";
import { OperationsSection } from "./OperationsSection";
import { ProvidersSection } from "./ProvidersSection";

/**
 * Design D: two split cards of the same shape, Providers and Models, then the Operations rows. Everything that comes
 * in numbers (providers, tiers, custom models) is a row in a list with the selected one's settings beside it, so the
 * page is the same shape with one provider or eight. Before a provider is added there is one empty state and nothing
 * else.
 */
export const dVariant: AgentsVariant = {
  id: "d",
  label: "D · Split cards",
  author: "Fable 5.1",
  Page: function AgentsPageD({ settings }) {
    const t3 = useIntegrationsStatus().data?.t3;
    const any = settings.providers.length > 0;
    return (
      <>
        <ProvidersSection settings={settings} />
        {any ? <ModelsSection settings={settings} t3={t3} /> : null}
        {any ? <OperationsSection settings={settings} /> : null}
      </>
    );
  },
};
