// Composer controls modelled on T3 Code's new-thread composer (ComposerControl, ModelPickerContent,
// TraitsPicker, BranchToolbar), MIT — see NOTICE. Rebuilt on our primitives rather than copied.
import type { T3LaunchOptions, T3LaunchProvider, T3ModelSelection, T3RuntimeMode } from "@repo/contracts";
import {
  BotIcon,
  BrainIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  HistoryIcon,
  LockIcon,
  LockOpenIcon,
  SearchIcon,
  SparkleIcon,
  StarIcon,
  ZapIcon,
} from "lucide-react";
import { useState, type ComponentProps } from "react";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import {
  FAVORITES,
  findModel,
  initialPickerTab,
  modelTraits,
  optionValue,
  pickerModels,
  refBadge,
  refDisabledReason,
  refLabel,
  runtimeModesFor,
  selectModel,
  selectedRef,
  setOption,
  WORKSPACE_LABELS,
  workspaceLabel,
  type PickerModel,
  type WorkspaceChoice,
  type WorkspaceMode,
} from "./handoff.logic";

/** T3's composer toolbar control ("sm"), or its dimmer strip control below the composer ("xs"). */
export function ComposerControl({
  className,
  size = "sm",
  ...props
}: ComponentProps<"button"> & { size?: "sm" | "xs" }) {
  return (
    <button
      type="button"
      className={cn(
        "relative inline-flex min-w-0 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-(--control-radius) border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-accent [&_svg]:pointer-events-none [&_svg]:shrink-0",
        size === "xs"
          ? "h-6 gap-1 px-1.75 text-xs font-normal text-muted-foreground/70 hover:text-foreground/80 [&_svg:not([class*='size-'])]:size-3.5"
          : "h-7 gap-1.5 px-2.5 text-sm font-medium text-secondary-label hover:text-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        "aria-pressed:bg-accent aria-pressed:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

const Chevron = () => <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />;

export function ProviderIcon({ driver, className }: { driver: string; className?: string }) {
  if (driver === "claudeAgent") return <SparkleIcon aria-hidden className={cn("text-[#D97757]", className)} />;
  return <BotIcon aria-hidden className={className} />;
}

// ── Model ────────────────────────────────────────────────────────────────

export function ModelPicker({
  options,
  selection,
  onChange,
}: {
  options: T3LaunchOptions;
  selection: T3ModelSelection | null;
  onChange: (selection: T3ModelSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(() => initialPickerTab(options, selection));
  const [query, setQuery] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const current = findModel(options, selection);
  const { models, legacy } = pickerModels(options, tab, query);

  const pick = (entry: PickerModel) => {
    onChange(selectModel(selection, entry));
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          setTab(initialPickerTab(options, selection));
        }
      }}
    >
      <PopoverTrigger render={<ComposerControl className="max-w-56" aria-label="Model" />}>
        {current ? <ProviderIcon driver={current.provider.driver} /> : null}
        <span className="min-w-0 truncate">{current?.model.name ?? "Choose a model"}</span>
        <Chevron />
      </PopoverTrigger>
      <PopoverPopup align="start" padding="none" className="before:hidden">
        <div className="flex max-h-86.5 w-screen max-w-90 flex-row overflow-hidden">
          <div className="flex w-11 shrink-0 flex-col items-center gap-1 py-2">
            <RailButton active={tab === FAVORITES} label="Favorites" onClick={() => setTab(FAVORITES)}>
              <StarIcon className="size-4.5 fill-current" />
            </RailButton>
            {options.providers.map((provider) => (
              <RailButton
                key={provider.instanceId}
                active={tab === provider.instanceId}
                label={provider.ready ? provider.displayName : `${provider.displayName} (unavailable)`}
                onClick={() => setTab(provider.instanceId)}
              >
                <ProviderIcon driver={provider.driver} className={cn("size-4.5", !provider.ready && "opacity-40")} />
              </RailButton>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-l border-border/70 bg-muted/40">
            <label className="mx-2 mt-2 flex items-center gap-2 border-b border-border px-1 pb-2 text-sm focus-within:border-primary">
              <SearchIcon aria-hidden className="size-4 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models..."
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
              {models.map((entry) => (
                <ModelRow
                  key={`${entry.provider.instanceId}:${entry.model.slug}`}
                  entry={entry}
                  selected={
                    entry.provider.instanceId === selection?.instanceId && entry.model.slug === selection?.model
                  }
                  onPick={pick}
                />
              ))}
              {legacy.length > 0 ? (
                <>
                  <button
                    type="button"
                    aria-expanded={legacyOpen}
                    onClick={() => setLegacyOpen((v) => !v)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium leading-snug">Legacy models</span>
                      <span className="mt-1 block text-xs leading-snug text-muted-foreground/70">
                        {legacy.length} models
                      </span>
                    </span>
                    <ChevronRightIcon className={cn("size-4 transition-transform", legacyOpen && "rotate-90")} />
                  </button>
                  {legacyOpen
                    ? legacy.map((entry) => (
                        <ModelRow
                          key={`${entry.provider.instanceId}:${entry.model.slug}`}
                          entry={entry}
                          selected={
                            entry.provider.instanceId === selection?.instanceId && entry.model.slug === selection?.model
                          }
                          onPick={pick}
                        />
                      ))
                    : null}
                </>
              ) : null}
              {models.length === 0 && legacy.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {tab === FAVORITES && !query ? "No favorite models yet" : "No models found"}
                </p>
              ) : null}
            </div>
            <ProviderNotice provider={options.providers.find((p) => p.instanceId === tab)} />
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function RailButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:text-foreground aria-pressed:after:absolute aria-pressed:after:-right-1.5 aria-pressed:after:h-5 aria-pressed:after:w-0.5 aria-pressed:after:rounded-full aria-pressed:after:bg-primary"
    >
      {children}
    </button>
  );
}

function ModelRow({
  entry,
  selected,
  onPick,
}: {
  entry: PickerModel;
  selected: boolean;
  onPick: (entry: PickerModel) => void;
}) {
  const disabled = !entry.provider.ready;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(entry)}
      aria-current={selected || undefined}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-50 aria-current:bg-accent/60"
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-xs font-medium leading-snug">
          <span className="truncate">{entry.model.name}</span>
          {entry.model.badge === "new" ? (
            <span className="rounded-sm border border-info/40 px-1 text-[10px] font-semibold uppercase text-info">
              New
            </span>
          ) : null}
        </span>
        <span className="mt-1 flex items-center gap-1 text-xs leading-snug text-muted-foreground/70">
          <ProviderIcon driver={entry.provider.driver} className="size-3" />
          {entry.provider.displayName}
          {disabled ? " · unavailable" : null}
        </span>
      </span>
      {selected ? <CheckIcon aria-hidden className="size-4 text-muted-foreground" /> : null}
    </button>
  );
}

function ProviderNotice({ provider }: { provider: T3LaunchProvider | undefined }) {
  if (!provider || provider.ready) return null;
  return (
    <p className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground">
      {provider.message ?? `${provider.displayName} isn't ready in T3 Code.`}
    </p>
  );
}

// ── Effort and fast mode ─────────────────────────────────────────────────

export function TraitsPicker({
  options,
  selection,
  onChange,
}: {
  options: T3LaunchOptions;
  selection: T3ModelSelection;
  onChange: (selection: T3ModelSelection) => void;
}) {
  const { effort, fastMode } = modelTraits(findModel(options, selection)?.model);
  if (!effort && !fastMode) return null;
  const effortValue = effort ? optionValue(selection, effort) : null;
  const effortLabel = effort?.options.find((o) => o.id === effortValue)?.label ?? effort?.label;
  const fast = fastMode ? optionValue(selection, fastMode) === true : false;
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl aria-label="Model options" />}>
        {fast ? <ZapIcon /> : <BrainIcon />}
        <span>{effortLabel ?? "Fast"}</span>
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start">
        {effort ? (
          <MenuGroup>
            <MenuGroupLabel>{effort.label}</MenuGroupLabel>
            <MenuRadioGroup
              value={effortValue}
              onValueChange={(value: string) => onChange(setOption(selection, effort.id, value))}
            >
              {effort.options.map((option) => (
                <MenuRadioItem key={option.id} value={option.id}>
                  {option.label}
                  {option.isDefault ? <span className="text-muted-foreground"> (default)</span> : null}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}
        {effort && fastMode ? <MenuSeparator /> : null}
        {fastMode ? (
          <MenuCheckboxItem
            variant="switch"
            checked={fast}
            onCheckedChange={(checked) => onChange(setOption(selection, fastMode.id, checked))}
          >
            {fastMode.label}
          </MenuCheckboxItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

// ── Access ───────────────────────────────────────────────────────────────

export function AccessPicker({
  provider,
  value,
  onChange,
}: {
  provider: T3LaunchProvider | undefined;
  value: T3RuntimeMode;
  onChange: (mode: T3RuntimeMode) => void;
}) {
  const modes = runtimeModesFor(provider);
  const current = modes.find((m) => m.value === value) ?? modes[0];
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl aria-label="Access" />}>
        {value === "full-access" ? <LockOpenIcon /> : <LockIcon />}
        <span>{current?.label}</span>
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={value} onValueChange={(mode: T3RuntimeMode) => onChange(mode)}>
          {modes.map((mode) => (
            <MenuRadioItem key={mode.value} value={mode.value} className="py-1.5">
              <span className="block">{mode.label}</span>
              <span className="block text-xs text-muted-foreground">{mode.description}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

// ── Workspace and branch ─────────────────────────────────────────────────

export function WorkspaceMenu({
  options,
  choice,
  onChange,
}: {
  options: T3LaunchOptions;
  choice: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
}) {
  const icon = { current: FolderIcon, new_worktree: FolderGit2Icon, previous: HistoryIcon }[choice.mode];
  const Icon = icon;
  return (
    <Menu>
      <MenuTrigger render={<ComposerControl size="xs" aria-label="Workspace" />}>
        <Icon />
        {workspaceLabel(options, choice)}
        <Chevron />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>Workspace</MenuGroupLabel>
          <MenuRadioGroup value={choice.mode} onValueChange={(mode: WorkspaceMode) => onChange({ mode, ref: null })}>
            <MenuRadioItem value="current">
              <span className="flex items-center gap-2">
                <FolderIcon /> {WORKSPACE_LABELS.current}
              </span>
            </MenuRadioItem>
            <MenuRadioItem value="new_worktree" disabled={!options.isRepo}>
              <span className="flex items-center gap-2">
                <FolderGit2Icon /> {WORKSPACE_LABELS.new_worktree}
              </span>
            </MenuRadioItem>
            {options.previousWorktree ? (
              <MenuRadioItem value="previous">
                <span className="flex items-center gap-2">
                  <HistoryIcon /> {WORKSPACE_LABELS.previous}
                </span>
                {options.previousWorktree.branch ? (
                  <span className="block ps-6 text-xs text-muted-foreground">{options.previousWorktree.branch}</span>
                ) : null}
              </MenuRadioItem>
            ) : null}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function RefPicker({
  options,
  choice,
  onChange,
}: {
  options: T3LaunchOptions;
  choice: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = selectedRef(options, choice);
  const q = query.trim().toLowerCase();
  const refs = options.refs.filter((ref) => !q || ref.name.toLowerCase().includes(q));
  const disabled = !options.isRepo || choice.mode === "previous";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <PopoverTrigger render={<ComposerControl size="xs" aria-label="Branch" disabled={disabled} />}>
        <GitBranchIcon />
        <span className="max-w-56 truncate">{options.isRepo ? refLabel(options, choice) : "Not a git repository"}</span>
        <Chevron />
      </PopoverTrigger>
      <PopoverPopup align="end" padding="none" className="before:hidden">
        <div className="flex max-h-80 w-screen max-w-80 flex-col overflow-hidden p-1.5">
          <label className="mx-1 mb-1 flex items-center gap-2 border-b border-border px-1 pb-2 text-sm focus-within:border-primary">
            <SearchIcon aria-hidden className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search refs..."
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </label>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {refs.map((ref) => {
              const reason = refDisabledReason(ref, choice.mode, options.workspaceRoot);
              const badge = refBadge(ref, options.workspaceRoot);
              return (
                <button
                  key={ref.name}
                  type="button"
                  disabled={reason !== null}
                  title={reason ?? undefined}
                  aria-current={ref.name === current?.name || undefined}
                  onClick={() => {
                    onChange({ ...choice, ref: ref.name });
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:cursor-not-allowed disabled:opacity-45 aria-current:bg-accent/60"
                >
                  <span className="min-w-0 flex-1 truncate">{ref.name}</span>
                  {badge ? <span className="shrink-0 text-xs text-muted-foreground/70">{badge}</span> : null}
                </button>
              );
            })}
            {refs.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">No refs found</p>
            ) : null}
          </div>
          {choice.mode === "current" ? (
            <p className="border-t border-border/70 px-2 pt-2 pb-1 text-xs leading-snug text-muted-foreground">
              Other branches need a checkout. Pick New worktree to start from one.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
