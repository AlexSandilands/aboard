import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_CONTEXT_KEYS,
  KeybindingCommand,
  type KeybindingOverrides,
  keybindingConflicts,
  parseWhen,
  type AppSettings,
  type ResolvedKeybinding,
} from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type KeyboardEvent } from "react";
import { IS_MAC } from "~/components/layout/keyboard";
import { formatShortcut, shortcutFromEvent } from "~/components/layout/keyboard.logic";
import { useResolvedKeybindings } from "~/components/layout/useKeybindings";
import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { useUpdateSettings } from "~/state/mutations";
import { queryKeys } from "~/state/queries";
import { BlurInput } from "./BlurInput";
import {
  TYPING_WARNING,
  describeConflict,
  triggersWhileTyping,
  withOverride,
  withoutOverride,
} from "./keybindings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** The commands, grouped by the heading each is listed under, in registry order. */
const GROUPS = [...new Set(KeybindingCommand.options.map((command) => DEFAULT_KEYBINDINGS[command].group))];

/** Settings → Board → Keybindings: every shortcut with its key and `when` condition, conflicts flagged. */
export function KeybindingsSection({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const queryClient = useQueryClient();
  const bindings = useResolvedKeybindings();
  const conflicts = keybindingConflicts(bindings);
  const overrides = settings.keybindings;
  const customised = Object.keys(overrides).length > 0;
  /**
   * Saves the overrides `change` makes of the latest ones. A save replaces the whole map, so two edits in a row (a When
   * field saving on blur as another row's Reset is clicked) must each start from the one before, which is not yet in
   * this render's props: the cache is patched at once, and refetched if the save fails.
   */
  const save = (change: (current: KeybindingOverrides) => KeybindingOverrides) => {
    const cached = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    const keybindings = change(cached?.keybindings ?? overrides);
    if (cached) queryClient.setQueryData(queryKeys.settings, { ...cached, keybindings });
    update.mutate(
      { keybindings },
      { onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }) },
    );
  };
  return (
    <>
      {GROUPS.map((group, index) => (
        <SettingsSection
          key={group}
          title={index === 0 ? `Keybindings: ${group}` : group}
          headerAction={
            index === 0 && customised ? (
              <Button size="xs" variant="outline" onClick={() => save(() => ({}))}>
                Reset all
              </Button>
            ) : undefined
          }
        >
          {bindings
            .filter((binding) => DEFAULT_KEYBINDINGS[binding.command].group === group)
            .map((binding) => (
              <KeybindingRow
                key={binding.command}
                binding={binding}
                customised={overrides[binding.command] !== undefined}
                conflictsWith={conflicts.get(binding.command) ?? []}
                onChange={(patch) => save((current) => withOverride(current, binding.command, patch))}
                onReset={() => save((current) => withoutOverride(current, binding.command))}
              />
            ))}
        </SettingsSection>
      ))}
    </>
  );
}

function KeybindingRow({
  binding,
  customised,
  conflictsWith,
  onChange,
  onReset,
}: {
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
  return (
    <SettingsRow
      id={`board.keybindings.${binding.command}`}
      title={def.title}
      description={
        def.when
          ? `Default: ${formatShortcut(def.key, IS_MAC)}, when ${def.when}`
          : `Default: ${formatShortcut(def.key, IS_MAC)}`
      }
      status={
        conflictsWith.length > 0 || triggersWhileTyping(binding) ? (
          <span className="flex flex-col gap-0.5 text-warning-foreground">
            {conflictsWith.length > 0 ? <span>{describeConflict(conflictsWith)}</span> : null}
            {triggersWhileTyping(binding) ? <span>{TYPING_WARNING}</span> : null}
          </span>
        ) : null
      }
      control={
        <>
          <ShortcutRecorder shortcut={binding.key} title={def.title} onRecord={(key) => onChange({ key })} />
          <Button size="sm" variant="outline" disabled={!customised} onClick={onReset}>
            Reset
          </Button>
        </>
      }
    >
      <div className="mt-3 space-y-1">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="shrink-0">When</span>
          <BlurInput
            // Remount when the stored value changes under it (a reset), so the draft follows.
            key={binding.when}
            size="sm"
            aria-label={`${def.title}: when`}
            className="font-mono"
            placeholder="Always"
            value={binding.when}
            onSave={(next) => {
              const parsed = parseWhen(next);
              setWhenFailure(parsed.ok ? null : { when: binding.when, message: parsed.error });
              if (parsed.ok) onChange({ when: next });
            }}
          />
        </div>
        <p className={whenError ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground/80"}>
          {whenError ?? `Combine ${KEYBINDING_CONTEXT_KEYS.join(", ")} with !, && and || (and parentheses).`}
        </p>
      </div>
    </SettingsRow>
  );
}

/** A button that shows the key and, once clicked, takes the next key combination as the new one. */
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
      variant={recording ? "default" : "outline"}
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
      {recording ? "Press keys…" : <Kbd>{formatShortcut(shortcut, IS_MAC)}</Kbd>}
    </Button>
  );
}
