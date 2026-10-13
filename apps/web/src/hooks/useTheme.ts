// Adapted from T3 Code (apps/web/src/hooks/useTheme.ts), MIT — see NOTICE.
// Trimmed to light | dark | system; the index.html boot script reads the same key.
import { storageKey } from "@repo/contracts";
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = storageKey("theme");
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

let listeners: Array<() => void> = [];

function readTheme(): Theme {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Storage unavailable; fall through to the default.
  }
  return "dark";
}

function systemDark(): boolean {
  return window.matchMedia(MEDIA_QUERY).matches;
}

function resolve(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemDark() ? "dark" : "light") : theme;
}

function applyTheme(theme: Theme, suppressTransitions: boolean) {
  const root = document.documentElement;
  if (suppressTransitions) root.classList.add("no-transitions");
  const dark = resolve(theme) === "dark";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  if (suppressTransitions) {
    // Force a reflow so no-transitions applies before it is removed.
    void root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  const mq = window.matchMedia(MEDIA_QUERY);
  const onSystem = () => {
    if (readTheme() === "system") applyTheme("system", true);
    emit();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    applyTheme(readTheme(), true);
    emit();
  };
  mq.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
    mq.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "dark");
  const resolvedTheme = useSyncExternalStore(
    subscribe,
    () => resolve(readTheme()),
    () => "dark" as const,
  );

  const setTheme = useCallback((next: Theme) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Still apply for this session.
    }
    applyTheme(next, true);
    emit();
  }, []);

  return { theme, resolvedTheme, setTheme } as const;
}
