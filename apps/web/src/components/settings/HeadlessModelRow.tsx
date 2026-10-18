import type { AppSettings, HeadlessModel } from "@repo/contracts";
import { useState, type ReactNode } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "~/components/ui/select";
import { BlurInput } from "./BlurInput";
import {
  headlessModelForOption,
  headlessModelItems,
  headlessModelOption,
  headlessModelRun,
  typedHeadlessModel,
} from "./headlessModel.logic";
import { SettingsLink, SettingsRow } from "./settingsLayout";

/**
 * The model a headless job runs: one of the Model tiers, or a typed model. A tier with no Claude Code model leaves
 * `--model` off, so the CLI's default runs, and the row says so with a link to where it is set.
 */
export function HeadlessModelRow({
  id,
  title,
  description,
  info,
  label,
  tiers,
  value,
  allowDefault,
  onChange,
}: {
  id: string;
  title: string;
  description: ReactNode;
  info?: ReactNode;
  /** The controls' accessible name, e.g. "Import model". */
  label: string;
  tiers: AppSettings["modelTiers"];
  value: HeadlessModel | null;
  /** Offer "CLI default" (no choice), for jobs that run on the CLI's own model until one is picked. */
  allowDefault: boolean;
  onChange: (next: HeadlessModel | null) => void;
}) {
  // Custom was picked but no name typed yet: nothing to save, so the field shows empty until there is one.
  const [typing, setTyping] = useState(false);
  // Bumped when typed text is refused, to remount the field with the saved value.
  const [rejected, setRejected] = useState(0);
  const option = headlessModelOption(value, typing);
  const items = headlessModelItems(allowDefault);
  const run = headlessModelRun(tiers, value);
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      info={info}
      status={
        typing ? null : run.kind === "tier" ? (
          <>
            {run.label} runs <code className="font-mono">{run.model}</code>.
          </>
        ) : run.kind === "tier-unset" ? (
          <>
            {run.label} has no Claude Code model, so the CLI&apos;s default runs. Set one under{" "}
            <SettingsLink to={`models.tiers.${run.tier}`}>Model tiers</SettingsLink>.
          </>
        ) : null
      }
      control={
        <>
          <Select
            items={items}
            value={option}
            onValueChange={(next) => {
              if (typeof next !== "string" || next === option) return;
              const saved = headlessModelForOption(next, value);
              setTyping(saved === undefined);
              if (saved !== undefined) onChange(saved);
            }}
          >
            <SelectTrigger size="sm" className="sm:w-40" aria-label={`${label} source`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {option === "custom" ? (
            <BlurInput
              key={`${value && "model" in value ? value.model : "typing"}-${rejected}`}
              aria-label={label}
              size="sm"
              className="sm:w-40"
              placeholder="haiku"
              value={value && "model" in value ? value.model : ""}
              onSave={(next) => {
                const typed = typedHeadlessModel(next);
                if (!typed) {
                  // Not a model `--model` can take: show what is saved again instead of leaving the bad text.
                  setRejected((n) => n + 1);
                  return;
                }
                setTyping(false);
                onChange(typed);
              }}
            />
          ) : null}
        </>
      }
    />
  );
}
