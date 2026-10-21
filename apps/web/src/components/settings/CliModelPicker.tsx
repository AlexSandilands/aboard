import type { AgentModel } from "@repo/contracts";
import { useState } from "react";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { commitModel, modelMatches, suggestedModels } from "./cliModelPicker.logic";

/**
 * A CLI's model on the Model tiers page: a text field that suggests the models the CLI lists (their name and what it
 * says about them). Anything else can be typed, e.g. `claude-opus-5-5` or `sonnet[1m]`; clearing it means the CLI's
 * default. Saved on picking a suggestion or leaving the field, as the other fields on the page are.
 */
export function CliModelPicker({
  value,
  models,
  placeholder,
  label,
  onSave,
  className,
}: {
  /** The saved model, "" for none. */
  value: string;
  /** What the scan found; empty while it runs or when it failed. */
  models: readonly AgentModel[];
  placeholder: string;
  label: string;
  onSave: (next: string | null) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const [error, setError] = useState<string | null>(null);
  // A save from elsewhere (another tab, the cleared model) replaces what is in the field.
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
    setError(null);
  }
  const items = suggestedModels(models, value);

  const commit = (text: string) => {
    const result = commitModel(text, value);
    if (result.kind === "invalid") setError(result.error);
    else {
      setError(null);
      if (result.kind === "save") onSave(result.value);
    }
  };

  return (
    <Autocomplete
      items={items}
      value={draft}
      itemToStringValue={(model: AgentModel) => model.value}
      filter={(model: AgentModel, query: string) => modelMatches(model, query, value)}
      openOnInputClick
      onValueChange={(text, details) => {
        setDraft(text);
        setError(null);
        // A pick or the clear button is a finished edit; typing is saved when the field is left.
        if (details.reason === "item-press" || details.reason === "clear-press") commit(text);
      }}
    >
      <AutocompleteInput
        size="sm"
        showClear={draft !== ""}
        className={className}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        placeholder={placeholder}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          // With a suggestion highlighted, Enter picks it; otherwise it finishes what was typed.
          if (event.key === "Enter" && !event.defaultPrevented) commit(draft);
        }}
      />
      {items.length > 0 ? (
        <AutocompletePopup>
          <AutocompleteEmpty>No listed model matches: it is used as typed.</AutocompleteEmpty>
          <AutocompleteList>
            {(model: AgentModel) => (
              <AutocompleteItem key={model.value} value={model} className="flex-col items-start gap-0">
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="truncate">{model.label ?? model.value}</span>
                  {model.label ? (
                    <span className="truncate font-mono text-xs text-muted-foreground">{model.value}</span>
                  ) : null}
                </span>
                {model.description ? (
                  <span className="w-full truncate text-xs text-muted-foreground">{model.description}</span>
                ) : null}
              </AutocompleteItem>
            )}
          </AutocompleteList>
        </AutocompletePopup>
      ) : null}
    </Autocomplete>
  );
}
