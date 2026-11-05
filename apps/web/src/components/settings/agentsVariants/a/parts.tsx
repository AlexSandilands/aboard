// Shared pieces of design A: the section header with an info button, the model control a tier or custom model shows
// for one provider, and the slot beside it (the Preferred mark, or T3 Code's clear).
import type { ModelTierSetting, T3ModelCatalog, T3ModelSelection } from "@repo/contracts";
import { AGENT_HARNESSES, PROVIDERS, type CliEffort } from "@repo/contracts";
import { StarIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { CliModelPicker } from "~/components/models/ModelChoicePicker";
import { PickerIcon } from "~/components/models/PickerIcon";
import { T3ModelPicker } from "~/components/models/T3ModelPicker";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { type TierChange, type TierProvider } from "../../modelTiers.logic";
import { InfoHover, SettingsGroup } from "../../settingsLayout";

/**
 * The model pickers' trigger as a field, so it lines up with the inputs and selects of Settings instead of floating
 * as a composer chip. One width everywhere on the page, the settings text width.
 */
export const FIELD =
  "h-8 w-full max-w-none justify-between rounded-lg border-input bg-background px-2.5 font-normal text-foreground shadow-xs/5 hover:bg-accent/50 data-popup-open:bg-accent/50 sm:h-7 dark:bg-input/32";

/** The control column of a row: a field, then the slot. Rows of one card share it, so their controls line up. */
export const CONTROL_COLUMN =
  "grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-1.5 @min-[34rem]/row:w-[15.875rem]";

/** The provider's name as Providers shows it, so a tab reads the same as its row there. */
export const providerLabel = (provider: TierProvider) => PROVIDERS[provider === "t3" ? "t3-code" : provider].label;

export function ProviderMark({ provider, className }: { provider: TierProvider; className?: string }) {
  return (
    <PickerIcon
      icon={provider === "t3" ? { kind: "t3code" } : { kind: "harness", harness: provider }}
      className={className}
    />
  );
}

/** A settings section whose muted heading carries an info button, for the detail a heading has no room for. */
export function InfoSection({
  id,
  title,
  info,
  headerAction,
  children,
  bare = false,
}: {
  id?: string;
  title: string;
  info?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
  /** Children draw their own card. */
  bare?: boolean;
}) {
  return (
    <section id={id} className="scroll-mt-4 space-y-2.5">
      <div className="flex min-h-7 items-center justify-between gap-4 px-3 sm:px-4">
        <h2 className="flex min-h-7 items-center gap-1.5 text-sm font-normal text-foreground/70">
          {title}
          {info ? <InfoHover label={`More about ${title}`}>{info}</InfoHover> : null}
        </h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      {bare ? children : <SettingsGroup>{children}</SettingsGroup>}
    </section>
  );
}

export interface ModelContext {
  t3Ready: boolean;
  catalog: T3ModelCatalog | undefined;
  catalogError: string | null;
}

/** One provider's model (and effort) for a tier or a custom model. */
export function ProviderModelField({
  provider,
  name,
  setting,
  ctx,
  onChange,
}: {
  provider: TierProvider;
  /** The tier's or custom model's name, for the accessible labels. */
  name: string;
  setting: ModelTierSetting;
  ctx: ModelContext;
  onChange: (change: TierChange) => void;
}) {
  if (provider === "t3") {
    const { catalog } = ctx;
    if (!ctx.t3Ready || !catalog) {
      // The same box as a picker, so a row without one still lines up; why it can't open is said once, above the rows.
      const text = setting.t3?.label ?? (ctx.t3Ready ? (ctx.catalogError ?? "Loading models…") : "Not connected");
      return (
        <div
          aria-label={`${name} T3 Code model: ${text}`}
          role="img"
          className={cn(
            FIELD,
            "flex items-center justify-start gap-1.5 border text-sm text-muted-foreground opacity-64",
          )}
        >
          <ProviderMark provider="t3" />
          <span className="min-w-0 truncate">{text}</span>
        </div>
      );
    }
    return (
      <T3ModelPicker
        catalog={catalog}
        selection={setting.t3?.selection ?? null}
        ariaLabel={`${name} T3 Code model`}
        className={FIELD}
        onChange={(next: T3ModelSelection) =>
          onChange({ field: "t3", value: { selection: next, label: selectionLabel(catalog, next) } })
        }
      />
    );
  }
  return (
    <CliModelPicker
      harness={provider}
      model={setting.cli?.[provider] ?? ""}
      effort={setting.cliEffort?.[provider] ?? null}
      defaultLabel="Default model"
      ariaLabel={`${name} ${AGENT_HARNESSES[provider].label} model`}
      className={FIELD}
      onModel={(value: string | null, levels: readonly CliEffort[]) =>
        onChange({ field: "cli", harness: provider, value, levels })
      }
      onEffort={(value) => onChange({ field: "cliEffort", harness: provider, value })}
    />
  );
}

/**
 * The slot after a model field. For a CLI, the Preferred mark (when there are CLIs to choose between): lit on the
 * provider headless runs on this tier or model prefer; pressing an unlit one moves it here. For T3 Code, which has no
 * default row in its picker, the clear button.
 */
export function ProviderSlot({
  provider,
  name,
  setting,
  preferred,
  onChange,
}: {
  provider: TierProvider;
  name: string;
  setting: ModelTierSetting;
  /** Whether the Preferred marks show at all. */
  preferred: boolean;
  onChange: (change: TierChange) => void;
}) {
  if (provider === "t3") {
    return setting.t3 ? (
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Clear ${name} T3 Code model`}
        title="Back to T3 Code's default"
        onClick={() => onChange({ field: "t3", value: null })}
      >
        <XIcon />
      </Button>
    ) : (
      <span />
    );
  }
  if (!preferred) return <span />;
  const on = setting.provider === provider;
  const label = providerLabel(provider);
  const now = setting.provider ? providerLabel(setting.provider) : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-pressed={on}
            aria-label={`${name}: headless runs prefer ${label}`}
            onClick={() => {
              if (!on) onChange({ field: "headless", value: provider });
            }}
          >
            <StarIcon className={cn(on ? "fill-current text-warning" : "opacity-60")} />
          </Button>
        }
      />
      <TooltipPopup side="top" className="max-w-64">
        {on
          ? `Preferred: headless runs on ${name} use ${label} when it can do what the run needs.`
          : `Prefer ${label} for headless runs on ${name}${now ? ` (now ${now})` : ""}.`}
      </TooltipPopup>
    </Tooltip>
  );
}
