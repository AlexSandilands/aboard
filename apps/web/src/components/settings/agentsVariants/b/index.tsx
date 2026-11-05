import { SettingsSubsection } from "../../settingsLayout";
import type { AgentsVariant } from "../types";
import { CustomModelsSection } from "./CustomModelsSection";
import { OperationsSection } from "./OperationsSection";
import { ProvidersSection } from "./ProvidersSection";
import { TiersSection } from "./TiersSection";

/**
 * Design B, "One provider pane": each provider's tier models live in its own pane under Providers, beside its status,
 * connection and skill rows, so a new provider adds a pane rather than a column. Models keeps only what isn't per
 * provider (a tier's description and preferred provider, the custom models), and Operations stays a plain list.
 * Before the first provider is added, the page is one empty state with Add provider.
 */
export const bVariant: AgentsVariant = {
  id: "b",
  label: "B · One provider pane",
  author: "Fable 5.1",
  Page: function BAgentsPage({ settings }) {
    return (
      <>
        <ProvidersSection settings={settings} />
        {settings.providers.length > 0 ? (
          <>
            <SettingsSubsection id="agents.models">
              <TiersSection settings={settings} />
              <CustomModelsSection settings={settings} />
            </SettingsSubsection>
            <OperationsSection settings={settings} />
          </>
        ) : null}
      </>
    );
  },
};
