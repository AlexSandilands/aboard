import { MODEL_TIERS, type AppSettings, type ModelTier } from "@repo/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useRescanAgentModels, useUpdateSettings } from "~/state/mutations";
import { useAgentModels } from "~/state/queries";
import { BlurInput } from "../../BlurInput";
import { createTierEdits, saveTierChange, type TierChange, type TierProvider } from "../../modelTiers.logic";
import { SettingsLink, StatusDot } from "../../settingsLayout";
import {
  CONTROL_COLUMN,
  InfoSection,
  ProviderMark,
  ProviderModelField,
  ProviderSlot,
  providerLabel,
  type ModelContext,
} from "./parts";
import { showsPreferred, tabForKey } from "./variantA.logic";

/**
 * The tiers, one provider at a time: a tab per provider added and on, and under it each tier's model on that one.
 * However many providers there are, a row keeps the same three parts (the tier, its model, the Preferred mark), so
 * nothing narrows or wraps as providers are added. A tier's description is the tier's own, the same on every tab.
 */
export function TiersCard({
  settings,
  shown,
  tab,
  onTab,
  ctx,
  status,
}: {
  settings: AppSettings;
  shown: readonly TierProvider[];
  tab: TierProvider;
  onTab: (tab: TierProvider) => void;
  ctx: ModelContext;
  /** A provider's warning, for the dot on its tab and the line above its rows; null when it is fine. */
  status: (provider: TierProvider) => string | null;
}) {
  const updateSettings = useUpdateSettings();
  const anyCli = shown.some((p) => p !== "t3");
  const scanned = useAgentModels(anyCli);
  const rescan = useRescanAgentModels();
  const edits = useRef(createTierEdits()).current;
  // mutateAsync, since mutate's per-call callbacks only run for the latest of overlapping saves, and each must settle.
  const save = (tier: ModelTier, change: TierChange) =>
    void saveTierChange(edits, updateSettings.mutateAsync, settings.modelTiers[tier], tier, change);
  const preferred = showsPreferred(shown);
  const warning = status(tab);
  const tabList = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    const next = tabForKey(shown, tab, event.key);
    if (!next) return;
    event.preventDefault();
    onTab(next);
    tabList.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <InfoSection
      id="agents.models.tiers.list"
      title="Tiers"
      info={
        <>
          <p>
            A planning agent suggests a tier for each task; a session on a provider starts on the model set here for it,
            or the provider's default. The description is named in prompts copied from a task.
          </p>
          <p className="mt-2">
            {preferred
              ? "The star marks the CLI headless runs on a tier prefer, when it can do what the run needs; else they use the first that can in Providers."
              : "Headless runs use the first provider in Providers that can do what the run needs."}
          </p>
        </>
      }
      headerAction={
        anyCli ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="-me-2"
            disabled={rescan.isPending || scanned.isFetching}
            onClick={() => rescan.mutate()}
            title="Ask the CLIs which models they offer"
          >
            {rescan.isPending || scanned.isFetching ? <Spinner /> : <RefreshCwIcon />}
            <span className="hidden sm:inline">Rescan models</span>
          </Button>
        ) : null
      }
    >
      <div
        ref={tabList}
        role="tablist"
        aria-label="Provider"
        // Scrolls sideways once the tabs outgrow the card, rather than wrapping or squeezing them.
        className="flex gap-1 overflow-x-auto px-2 [scrollbar-width:none] sm:px-3 [&::-webkit-scrollbar]:hidden"
      >
        {shown.map((provider) => {
          const selected = provider === tab;
          const problem = status(provider);
          return (
            <button
              key={provider}
              type="button"
              role="tab"
              data-tab={provider}
              id={`a-tier-tab-${provider}`}
              aria-selected={selected}
              aria-controls="a-tier-panel"
              tabIndex={selected ? 0 : -1}
              className={cn(
                "relative flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                selected
                  ? "text-foreground after:bg-primary"
                  : "text-muted-foreground hover:text-foreground after:bg-transparent",
              )}
              onClick={() => onTab(provider)}
              onKeyDown={onKeyDown}
            >
              <ProviderMark provider={provider} className={cn(!selected && "opacity-70")} />
              {providerLabel(provider)}
              {problem ? <StatusDot tone="warning" label={problem} /> : null}
            </button>
          );
        })}
      </div>
      <div id="a-tier-panel" role="tabpanel" aria-labelledby={`a-tier-tab-${tab}`}>
        {warning ? (
          <p className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground sm:px-4">
            <StatusDot tone="warning" label="Warning" />
            <span className="min-w-0">
              {warning}{" "}
              <SettingsLink to={`agents.providers.${tab === "t3" ? "t3-code" : tab}`}>Open in Providers</SettingsLink>
            </span>
          </p>
        ) : null}
        <div className="[&>*+*]:border-t [&>*+*]:border-border/50">
          {MODEL_TIERS.map(({ value: tier, label, description }) => {
            const setting = settings.modelTiers[tier];
            const name = `${label} tier`;
            return (
              <div
                key={tier}
                id={`agents.models.tiers.${tier}`}
                role="group"
                aria-label={name}
                className="@container/row scroll-mt-4 px-3 py-2.5 sm:px-4"
              >
                <div className="flex flex-col gap-2 @min-[34rem]/row:flex-row @min-[34rem]/row:items-center @min-[34rem]/row:gap-6">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-foreground" title={description}>
                      {label}
                    </h3>
                    <BlurInput
                      unstyled
                      size="compact"
                      aria-label={`${label} tier description`}
                      // Reads as the row's description line until hovered or focused, when it shows it is a field.
                      className="-ms-[9px] w-[calc(100%+9px)] max-w-sm rounded-md text-xs text-muted-foreground transition-colors hover:bg-accent/40 focus-within:bg-background focus-within:text-foreground focus-within:ring-1 focus-within:ring-ring/60 [&_input]:h-6 [&_input]:leading-6"
                      placeholder="Add a description, e.g. Sonnet, medium"
                      value={setting.description ?? ""}
                      onSave={(next) => save(tier, { field: "description", value: next.trim() || null })}
                    />
                  </div>
                  <div className={CONTROL_COLUMN}>
                    <ProviderModelField
                      provider={tab}
                      name={name}
                      setting={setting}
                      ctx={ctx}
                      onChange={(change) => save(tier, change)}
                    />
                    <ProviderSlot
                      provider={tab}
                      name={name}
                      setting={setting}
                      preferred={preferred}
                      onChange={(change) => save(tier, change)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </InfoSection>
  );
}
