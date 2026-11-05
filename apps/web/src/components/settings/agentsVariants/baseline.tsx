import { useIntegrationsStatus } from "~/state/queries";
import { ModelsPage } from "../ModelsPage";
import { ProvidersPage } from "../ProvidersPage";
import type { AgentsVariant } from "./types";

/** The design as it was before #97: Providers above the old Models page. */
export const baselineVariant: AgentsVariant = {
  id: "baseline",
  label: "Current",
  author: "before #97",
  Page: function BaselineAgentsPage({ settings }) {
    const t3 = useIntegrationsStatus().data?.t3;
    return (
      <>
        <ProvidersPage settings={settings} />
        <ModelsPage settings={settings} t3={t3} />
      </>
    );
  },
};
