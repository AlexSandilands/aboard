import { type KeybindingCommand, type ResolvedKeybinding, resolveKeybindings } from "@repo/contracts";
import { useMemo } from "react";
import { useSettings } from "~/state/queries";
import { IS_MAC } from "./keyboard";
import { formatShortcut } from "./keyboard.logic";

/** Every command's binding with the user's overrides applied (the defaults until settings load). */
export function useResolvedKeybindings(): ResolvedKeybinding[] {
  const overrides = useSettings().data?.keybindings;
  return useMemo(() => resolveKeybindings(overrides), [overrides]);
}

/** A command's key as people read it (`Ctrl+K`), for tooltips and menus; null when nothing is bound to it. */
export function useShortcutLabel(command: KeybindingCommand): string | null {
  const bindings = useResolvedKeybindings();
  const binding = bindings.find((b) => b.command === command);
  return binding ? formatShortcut(binding.key, IS_MAC) : null;
}
