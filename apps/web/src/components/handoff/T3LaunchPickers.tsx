// Composer controls modelled on T3 Code's new-thread composer (ComposerControl and
// BranchToolbar), MIT — see NOTICE. Rebuilt on our primitives rather than copied.
import { runtimeModesFor, type T3LaunchOptions, type T3LaunchProvider, type T3RuntimeMode } from "@repo/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  FolderIcon,
  HistoryIcon,
  LockIcon,
  LockOpenIcon,
} from "lucide-react";
import { type ComponentProps } from "react";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { ClaudeAI, OpenAI } from "~/components/handoff/providerIcons";
import { cn } from "~/lib/utils";
import { WORKSPACE_LABELS, workspaceLabel, type WorkspaceChoice, type WorkspaceMode } from "./handoff.logic";

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

/** The strip under the composer, inset 22px each side and tucked under it like T3 Code's drawer. */
export function ComposerStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "-mt-3 mx-auto flex w-[calc(100%-2.75rem)] items-center rounded-b-xl border border-t-0 border-border bg-muted/30 px-2 pt-4 pb-1.5",
        className,
      )}
      {...props}
    />
  );
}

const Chevron = () => <ChevronDownIcon aria-hidden className="-me-1 size-3.5 opacity-60" />;

export function ProviderIcon({ driver, className }: { driver: string; className?: string }) {
  if (driver === "claudeAgent") return <ClaudeAI aria-hidden className={cn("size-4", className)} />;
  if (driver === "codex") return <OpenAI aria-hidden className={cn("size-4", className)} />;
  return <BotIcon aria-hidden className={cn("size-4", className)} />;
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
