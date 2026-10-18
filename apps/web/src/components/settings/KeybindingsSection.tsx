import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_CONTEXT_KEYS,
  type KeybindingOverrides,
  keybindingConflicts,
  parseWhen,
  type AppSettings,
  type ResolvedKeybinding,
} from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { IS_MAC } from "~/components/layout/keyboard";
import { formatShortcut, shortcutFromEvent, shortcutParts } from "~/components/layout/keyboard.logic";
import { useResolvedKeybindings } from "~/components/layout/useKeybindings";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { useUpdateSettings } from "~/state/mutations";
import { queryKeys } from "~/state/queries";
import { useSettingsNav } from "~/state/ui";
import { BlurInput } from "./BlurInput";
import {
  TYPING_WARNING,
  describeConflict,
  isCustomised,
  keybindingSections,
  triggersWhileTyping,
  whenSummary,
  withOverride,
  withoutOverride,
} from "./keybindings.logic";
import { InfoHover, SettingsGroup, SettingsRow, SettingsSection, SettingsSubsection } from "./settingsLayout";

/**
 * The Keybindings page: a search box, then a sub-section per group of the keybinding registry with a row per
 * command. A command added to the registry is listed here with no change to this file.
 */
export function KeybindingsSection({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const queryClient = useQueryClient();
  const bindings = useResolvedKeybindings();
  const conflicts = keybindingConflicts(bindings);
  const overrides = settings.keybindings;
  const customised = Object.keys(overrides).length > 0;
  const [query, setQuery] = useState("");
  // A link or a search pick that lands on a row this filter hides would find nothing to scroll to: clear the filter.
  const target = useSettingsNav((s) => s.scrollTarget);
  const [clearedFor, setClearedFor] = useState<number | null>(null);
  if (target && target.nonce !== clearedFor && target.id.startsWith("keybindings.")) {
    setClearedFor(target.nonce);
    if (query) setQuery("");
  }
  const sections = keybindingSections(bindings, query, (shortcut) => formatShortcut(shortcut, IS_MAC));
  // The overrides the newest save sent, kept while any save is in flight. An earlier save's reply lands in the cache
  // (useUpdateSettings) and would otherwise be what the next edit is built from, dropping the saves after it.
  const pending = useRef<{ count: number; latest: KeybindingOverrides } | null>(null);
  /**
   * Saves the overrides `change` makes of the latest ones. A save replaces the whole map, so two edits in a row (a When
   * field saving on blur as another row's Reset is clicked) must each start from the one before, which is not yet in
   * this render's props: the cache is patched at once, and refetched if a save fails.
   */
  const save = (change: (current: KeybindingOverrides) => KeybindingOverrides) => {
    const cached = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    const keybindings = change(pending.current?.latest ?? cached?.keybindings ?? overrides);
    if (cached) queryClient.setQueryData(queryKeys.settings, { ...cached, keybindings });
    pending.current = { count: (pending.current?.count ?? 0) + 1, latest: keybindings };
    // mutateAsync, because mutate's callbacks only run for the latest call.
    update
      .mutateAsync({ keybindings })
      .catch(() => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }))
      .finally(() => {
        // The hook already reports a failure. Later saves replaced the record, so count down on the current one.
        const current = pending.current;
        if (current && --current.count === 0) pending.current = null;
      });
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            size="sm"
            value={query}
            placeholder="Search keybindings"
            aria-label="Search keybindings"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query) return;
              // The first Esc clears the box; the page's own Esc (back to the board) is for the next.
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }}
          />
        </InputGroup>
        {customised ? (
          <Button size="sm" variant="outline" onClick={() => save(() => ({}))}>
            Reset all
          </Button>
        ) : null}
      </div>
      {sections.length === 0 ? (
        <SettingsGroup>
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No keybindings match your search.</p>
        </SettingsGroup>
      ) : (
        sections.map((section) => (
          <SettingsSubsection key={section.sectionId} id={section.sectionId}>
            <SettingsSection title={section.label}>
              {section.bindings.map((binding) => (
                <KeybindingRow
                  key={binding.command}
                  slug={section.slug}
                  binding={binding}
                  customised={isCustomised(overrides, binding.command)}
                  conflictsWith={conflicts.get(binding.command) ?? []}
                  onChange={(patch) => save((current) => withOverride(current, binding.command, patch))}
                  onReset={() => save((current) => withoutOverride(current, binding.command))}
                />
              ))}
            </SettingsSection>
          </SettingsSubsection>
        ))
      )}
    </>
  );
}

function KeybindingRow({
  slug,
  binding,
  customised,
  conflictsWith,
  onChange,
  onReset,
}: {
  slug: string;
  binding: ResolvedKeybinding;
  customised: boolean;
  conflictsWith: ResolvedKeybinding["command"][];
  onChange: (patch: { key?: string; when?: string }) => void;
  onReset: () => void;
}) {
  const def = DEFAULT_KEYBINDINGS[binding.command];
  // Tied to the value it was raised for, so a reset (which changes the stored one) clears it.
  const [whenFailure, setWhenFailure] = useState<{ when: string; message: string } | null>(null);
  const whenError = whenFailure?.when === binding.when ? whenFailure.message : null;
  const typing = triggersWhileTyping(binding);
  return (
    <SettingsRow
      id={`keybindings.${slug}.${binding.command}`}
      className="py-2.5"
      title={def.title}
      description={
        <WhenEditor
          title={def.title}
          when={binding.when}
          error={whenError}
          onSave={(next) => {
            const parsed = parseWhen(next);
            setWhenFailure(parsed.ok ? null : { when: binding.when, message: parsed.error });
            if (parsed.ok) onChange({ when: next });
          }}
        />
      }
      status={
        whenError || conflictsWith.length > 0 || typing ? (
          <span className="flex flex-col gap-0.5">
            {whenError ? <span className="text-destructive-foreground">Not saved: {whenError}</span> : null}
            {conflictsWith.length > 0 ? (
              <span className="text-warning-foreground">{describeConflict(conflictsWith)}</span>
            ) : null}
            {typing ? <span className="text-warning-foreground">{TYPING_WARNING}</span> : null}
          </span>
        ) : null
      }
      control={
        <>
          {customised ? (
            <Button
              size="xs"
              variant="ghost-muted"
              title={`Back to ${formatShortcut(def.key, IS_MAC)}${def.when ? `, when ${def.when}` : ""}`}
              aria-label={`Reset ${def.title} to its default`}
              onClick={onReset}
            >
              Reset
            </Button>
          ) : null}
          <ShortcutRecorder shortcut={binding.key} title={def.title} onRecord={(key) => onChange({ key })} />
        </>
      }
    />
  );
}

/**
 * The row's condition as a small "When Always" line, or the expression in mono; clicking it opens the editor. The
 * helper on what can be written sits in one info hover there, not under every row.
 */
function WhenEditor({
  title,
  when,
  error,
  onSave,
}: {
  title: string;
  when: string;
  error: string | null;
  onSave: (next: string) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Edit when for ${title}`}
        className={cn(
          "-ms-1.5 inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          error && "text-destructive-foreground",
        )}
      >
        <span className="shrink-0 text-muted-foreground/70">When</span>
        <span className={cn("min-w-0 truncate", when.trim() !== "" && "font-mono")}>{whenSummary(when)}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" width="md" padding="compact">
        <div className="w-full space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>When</span>
            <InfoHover label="What a When condition can say">
              Combine {KEYBINDING_CONTEXT_KEYS.join(", ")} with !, && and || (and parentheses). Leave it empty to always
              apply.
            </InfoHover>
          </div>
          <BlurInput
            // Remount when the stored value changes under it (a reset), so the draft follows.
            key={when}
            size="sm"
            font="mono"
            aria-label={`${title}: when`}
            placeholder="Always"
            value={when}
            onSave={onSave}
          />
          {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** A button that shows the key as chips and, once clicked, takes the next key combination as the new one. */
function ShortcutRecorder({
  shortcut,
  title,
  onRecord,
}: {
  shortcut: string;
  title: string;
  onRecord: (shortcut: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  // A focused button is clicked by Space on key up, which would start the recording again right after it ended.
  const justRecorded = useRef(false);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // The app's own shortcuts stand down for this control (`data-recording-shortcut`); the browser's and the page's
    // other key handlers must not see the key either.
    event.preventDefault();
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    const next = shortcutFromEvent(event, IS_MAC);
    if (next === null) return;
    justRecorded.current = true;
    setRecording(false);
    onRecord(next);
  };

  return (
    <Button
      size="sm"
      variant={recording ? "default" : "ghost"}
      aria-label={recording ? `Press the new shortcut for ${title}` : `Change the shortcut for ${title}`}
      data-recording-shortcut={recording ? "" : undefined}
      onClick={() => setRecording((current) => !current)}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (justRecorded.current && event.key === " ") event.preventDefault();
        justRecorded.current = false;
      }}
      onBlur={() => setRecording(false)}
    >
      {recording ? (
        "Press keys…"
      ) : (
        <span className="flex items-center gap-1">
          {shortcutParts(shortcut, IS_MAC).map((part) => (
            <Kbd key={part}>{part}</Kbd>
          ))}
        </span>
      )}
    </Button>
  );
}
