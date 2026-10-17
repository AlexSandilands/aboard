import { useSyncExternalStore } from "react";
import type * as RichEditor from "./richEditor.module";

type RichEditorModule = typeof RichEditor;

// TipTap and ProseMirror are a large part of the bundle, and only the editors use them.
let loaded: RichEditorModule | null = null;
let loading: Promise<RichEditorModule> | null = null;
const listeners = new Set<() => void>();

export function loadRichEditor(): Promise<RichEditorModule> {
  loading ??= import("./richEditor.module").then((module) => {
    loaded = module;
    for (const listener of listeners) listener();
    return module;
  });
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The rich editor's module once it has loaded (starting the load), else null. */
export function useRichEditor(): RichEditorModule | null {
  const module = useSyncExternalStore(subscribe, () => loaded);
  if (!module) void loadRichEditor();
  return module;
}

// Loaded when the browser is idle after start, so an editor opened later doesn't wait for it.
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1000));
  idle(() => void loadRichEditor());
}
