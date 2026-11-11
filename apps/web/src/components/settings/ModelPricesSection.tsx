import type { AppSettings } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { formatRelativeTimeLabel } from "~/lib/timestampFormat";
import { useRefreshModelPrices, useUpdateSettings } from "~/state/mutations";
import { queryKeys, useModelPrices } from "~/state/queries";
import { modelPricesDot, modelPricesLine } from "./integrations.logic";
import { SettingsRow, SettingsSection, StatusDot } from "./settingsLayout";

/** Where usage estimates' prices come from: LiteLLM's list, fetched daily, or the built-in table (token-usage.md). */
export function ModelPricesSection({ settings }: { settings: AppSettings }) {
  const status = useModelPrices().data;
  const queryClient = useQueryClient();
  const updateSettings = useUpdateSettings();
  const refresh = useRefreshModelPrices();
  const dot = modelPricesDot(status);
  const setFetch = (on: boolean) =>
    updateSettings.mutate(
      { modelPriceFetch: on },
      {
        onSuccess: () => {
          // Switching it on may fetch in the background; the status and prices are read again either way.
          for (const queryKey of [queryKeys.modelPrices, ["task"], ["stats"]]) {
            void queryClient.invalidateQueries({ queryKey });
          }
        },
      },
    );
  return (
    <SettingsSection
      id="integrations.model-prices.status"
      title="Model prices"
      status={<StatusDot tone={dot.tone} label={dot.label} />}
    >
      <SettingsRow
        id="integrations.model-prices.fetch"
        title="Fetch prices from LiteLLM"
        description="Download LiteLLM's model price list once a day for usage cost estimates. Off, estimates use the board's built-in prices."
        info="Only Anthropic's, OpenAI's and Google's own list prices are used. Your price overrides always win, and a model LiteLLM doesn't list falls back to the built-in prices."
        control={
          <Switch
            aria-label="Fetch prices from LiteLLM"
            checked={settings.modelPriceFetch}
            onCheckedChange={setFetch}
          />
        }
      />
      <SettingsRow
        id="integrations.model-prices.refresh"
        title="Prices in use"
        description={status ? modelPricesLine(status, formatRelativeTimeLabel) : "Checking..."}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!settings.modelPriceFetch || refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? "Refreshing..." : "Refresh now"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
