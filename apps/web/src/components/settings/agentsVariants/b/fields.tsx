import {
  AGENT_HARNESSES,
  AgentHarness,
  type CliEffort,
  type ModelTierSetting,
  type T3ModelCatalog,
  type T3ModelSelection,
} from "@repo/contracts";
import { selectionLabel } from "~/components/handoff/handoff.logic";
import { CliModelPicker } from "~/components/models/ModelChoicePicker";
import { T3ModelPicker } from "~/components/models/T3ModelPicker";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { cn } from "~/lib/utils";
import { useIntegrationsStatus, useSettings, useT3ModelCatalog } from "~/state/queries";
import type { TierChange, TierProvider } from "../../modelTiers.logic";
import { SETTINGS_NUMBER_WIDTH, SETTINGS_TEXT_WIDTH } from "../../settingsLayout";
import { t3FieldText, type PreferredChoice } from "./b.logic";

/**
 * The provider headless runs on a tier or custom model try first (`ModelTierSetting.provider`). Unset reads as the
 * first provider that can; like the radio it replaces, it can be set but not unset.
 */
export function PreferredSelect({
  choices,
  value,
  name,
  onChange,
}: {
  choices: readonly PreferredChoice[];
  value: AgentHarness | undefined;
  /** What it is the preferred provider of, for its accessible name. */
  name: string;
  onChange: (harness: AgentHarness) => void;
}) {
  return (
    <Select
      items={choices.map((choice) => ({ value: choice.harness, label: choice.label }))}
      value={value ?? null}
      onValueChange={(next) => {
        const harness = AgentHarness.safeParse(next);
        if (harness.success) onChange(harness.data);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={`${name} preferred provider`}
        className={cn("min-w-0", SETTINGS_NUMBER_WIDTH)}
      >
        <SelectValue placeholder="First that can" />
      </SelectTrigger>
      <SelectPopup>
        {choices.map((choice) => (
          <SelectItem key={choice.harness} value={choice.harness}>
            {/* Preflight makes the svg a block, so the icon and the name share a flex line. */}
            <span className="flex items-center gap-2">
              <HarnessIcon harness={choice.harness} className={cn("size-4", !choice.available && "opacity-50")} />
              {choice.label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * The shared model picker's trigger is a borderless composer control; in a settings row it sits beside bordered
 * inputs and selects, so it gets their field look and the text-control width, and one right edge with them.
 */
export const PICKER_FIELD = cn(
  "w-full max-w-none justify-between rounded-lg border-input bg-background font-normal text-foreground shadow-xs/5 hover:bg-accent/50 dark:bg-input/32 dark:hover:bg-input/48",
  SETTINGS_TEXT_WIDTH,
);

/** A field-shaped line of text where a picker would be: what a T3 Code model is while T3 Code can't list models. */
export function FieldText({ muted, children }: { muted: boolean; children: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 w-full min-w-0 items-center rounded-lg border border-input/60 px-2.5 text-sm",
        muted ? "text-muted-foreground" : "text-foreground/80",
        SETTINGS_TEXT_WIDTH,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

/** T3 Code's model catalog, asked for only once a saved token connects (the page's hooks share the cached answer). */
export function useT3Models(wanted: boolean): {
  ready: boolean;
  catalog: T3ModelCatalog | undefined;
  error: string | null;
} {
  const settings = useSettings().data;
  const t3 = useIntegrationsStatus().data?.t3;
  const ready = !!settings?.t3TokenSet && t3?.detected === true;
  const catalog = useT3ModelCatalog(wanted && ready);
  return { ready, catalog: catalog.data, error: catalog.error?.message ?? null };
}

/**
 * One provider's model for a tier or custom model: the CLI's picker with its default listed first (so clearing is a
 * pick, not a button), or T3 Code's picker over its catalog, which reads as text while T3 Code isn't connected.
 */
export function ModelField({
  provider,
  name,
  setting,
  onChange,
}: {
  provider: TierProvider;
  /** What the field sets, for its accessible name: "Light tier" or the custom model's name. */
  name: string;
  setting: ModelTierSetting;
  onChange: (change: TierChange) => void;
}) {
  const t3 = useT3Models(provider === "t3");
  if (provider === "t3") {
    const selection = setting.t3?.selection ?? null;
    if (!t3.ready || !t3.catalog) {
      const line = t3FieldText(t3.ready, t3.error, setting.t3?.label ?? null);
      return <FieldText muted={line.muted}>{line.text}</FieldText>;
    }
    const catalog = t3.catalog;
    return (
      <T3ModelPicker
        catalog={catalog}
        selection={selection}
        ariaLabel={`${name} T3 Code model`}
        size="sm"
        className={PICKER_FIELD}
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
      size="sm"
      className={PICKER_FIELD}
      onModel={(value: string | null, levels: readonly CliEffort[]) =>
        onChange({ field: "cli", harness: provider, value, levels })
      }
      onEffort={(value) => onChange({ field: "cliEffort", harness: provider, value })}
    />
  );
}
