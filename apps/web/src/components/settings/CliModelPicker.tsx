import type { AgentHarness, AgentModel, CliEffort } from "@repo/contracts";
import { BrainIcon, CheckIcon, ChevronDownIcon, CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { DEFAULT_EFFORT, effortItems, effortOfValue } from "~/components/handoff/cliEffort.logic";
import { ComposerControl } from "~/components/handoff/T3LaunchPickers";
import { HarnessIcon } from "~/components/sessions/SessionParts";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  arrowTarget,
  enterPick,
  filterModels,
  findSuggestion,
  suggestedModels,
  typedModel,
} from "./cliModelPicker.logic";

const Chevron = () => <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />;

/**
 * A CLI's model on the Model tiers page, looking like T3 Code's model picker: a button with the CLI's mark and the
 * model's name, opening a searchable list of the models the CLI lists. Anything else can be typed and used, e.g.
 * `claude-opus-5-5` or `sonnet[1m]`. Saved as soon as a model is picked.
 */
export function CliModelPicker({
  harness,
  cliName,
  value,
  models,
  loading = false,
  label,
  onSave,
}: {
  harness: AgentHarness;
  cliName: string;
  /** The saved model, "" for none. */
  value: string;
  /** What the scan found; empty while it runs, when it failed, or for a CLI that isn't scanned. */
  models: readonly AgentModel[];
  /** The scan is still running, so an empty list doesn't mean the CLI lists nothing. */
  loading?: boolean;
  label: string;
  onSave: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listed = suggestedModels(models, value);
  const shown = filterModels(listed, query);
  const typed = typedModel(query, listed);
  const current = findSuggestion(listed, value);
  const onEnter = enterPick(query, listed);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Arrow keys move between the search and the rows, as the Autocomplete this replaced did.
  const onArrow = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-option]") ?? [])];
    const from = rows.findIndex((row) => row === document.activeElement);
    const to = arrowTarget(from, rows.length, event.key);
    event.preventDefault();
    (to < 0 ? searchRef.current : rows[to])?.focus();
  };

  const pick = (next: string) => {
    if (next !== value.trim()) onSave(next);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger render={<ComposerControl className="max-w-64" aria-label={label} />}>
        <HarnessIcon harness={harness} className="size-4" />
        <span className={current ? "min-w-0 truncate" : "min-w-0 truncate text-muted-foreground"}>
          {current ? (current.label ?? current.value) : "Choose a model"}
        </span>
        <Chevron />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="none" className="before:hidden">
        <div className="flex max-h-86.5 w-screen max-w-90 flex-col overflow-hidden bg-muted/40">
          <label className="mx-2 mt-2 flex items-center gap-2 border-b border-border px-1 pb-2 text-sm focus-within:border-primary">
            <SearchIcon aria-hidden className="size-4 text-muted-foreground" />
            <input
              autoFocus
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return onArrow(event);
                event.preventDefault();
                if (onEnter) pick(onEnter);
              }}
              placeholder={`Search ${cliName} models or type one...`}
              aria-invalid={typed?.kind === "invalid" ? true : undefined}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
            {shown.map((model) => (
              <ModelRow
                key={model.value}
                harness={harness}
                cliName={cliName}
                model={model}
                selected={model.value === value.trim()}
                onEnter={model.value === onEnter}
                onKeyDown={onArrow}
                onPick={() => pick(model.value)}
              />
            ))}
            {typed?.kind === "use" ? (
              <button
                type="button"
                data-option
                onKeyDown={onArrow}
                onClick={() => pick(typed.value)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium leading-snug">
                    Use <span className="font-mono">{typed.value}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-snug text-muted-foreground/70">
                    Passed to {cliName} as typed
                  </span>
                </span>
                {onEnter === typed.value ? <EnterHint /> : null}
              </button>
            ) : null}
            {typed?.kind === "invalid" ? (
              <p className="px-2 py-3 text-center text-xs text-destructive-foreground">{typed.error}</p>
            ) : null}
            {shown.length === 0 && !typed ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                {loading && listed.length === 0
                  ? "Loading models..."
                  : listed.length === 0
                    ? "No models listed. Type one to use it."
                    : "No models found"}
              </p>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Marks the row Enter in the search picks. */
const EnterHint = () => <CornerDownLeftIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;

function ModelRow({
  harness,
  cliName,
  model,
  selected,
  onEnter,
  onKeyDown,
  onPick,
}: {
  harness: AgentHarness;
  cliName: string;
  model: AgentModel;
  selected: boolean;
  /** Enter in the search picks this row. */
  onEnter: boolean;
  onKeyDown: (event: KeyboardEvent) => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-option
      onKeyDown={onKeyDown}
      onClick={onPick}
      aria-current={selected || undefined}
      title={model.description ?? undefined}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent aria-current:bg-accent/60"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-xs font-medium leading-snug">
          <span className="truncate">{model.label ?? model.value}</span>
          {model.label ? (
            <span className="truncate font-mono text-[10px] font-normal text-muted-foreground/70">{model.value}</span>
          ) : null}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1 text-xs leading-snug text-muted-foreground/70">
          <HarnessIcon harness={harness} className="size-3" />
          <span className="truncate">{model.description ?? cliName}</span>
        </span>
      </span>
      {onEnter ? <EnterHint /> : null}
      {selected ? <CheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
    </button>
  );
}

/** The effort beside a CLI's model, as T3 Code's effort menu: the model's levels, or the CLI's own default. */
export function CliEffortMenu({
  value,
  levels,
  label,
  onChange,
}: {
  value: CliEffort | null;
  levels: readonly CliEffort[];
  label: string;
  onChange: (effort: CliEffort | null) => void;
}) {
  const items = effortItems(levels, value);
  const selected = value ?? DEFAULT_EFFORT;
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl aria-label={label} />}>
        <BrainIcon />
        <span>{items.find((item) => item.value === selected)?.label}</span>
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>Effort</MenuGroupLabel>
          <MenuRadioGroup value={selected} onValueChange={(next: string) => onChange(effortOfValue(next))}>
            {items.map((item) => (
              <MenuRadioItem key={item.value} value={item.value}>
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
