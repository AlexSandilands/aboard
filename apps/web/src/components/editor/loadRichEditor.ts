import { useEffect, useSyncExternalStore } from "react";
import type * as RichEditor from "./richEditor.module";

type RichEditorModule = typeof RichEditor;

/** The module once loaded; `failed` when the last load failed (a deploy changed the chunk, the network dropped). */
export interface RichEditorState {
  module: RichEditorModule | null;
  failed: boolean;
}

// TipTap and ProseMirror are a large part of the bundle, and only the editors use them.
let state: RichEditorState = { module: null, failed: false };
let loading: Promise<RichEditorModule | null> | null = null;
const listeners = new Set<() => void>();

const publish = (next: RichEditorState) => {
  state = next;
  for (const listener of listeners) listener();
};

/** Loads the editor's chunk; after a failure, the next call tries again. */
export function loadRichEditor(): Promise<RichEditorModule | null> {
  if (state.module) return Promise.resolve(state.module);
  loading ??= import("./richEditor.module").then(
    (module) => {
      publish({ module, failed: false });
      return module;
    },
    () => {
      loading = null;
      publish({ module: null, failed: true });
      return null;
    },
  );
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The rich editor's module once it has loaded. Each editor that mounts without it starts (or retries) the
 * load; while the last load has failed, editors fall back to the plain textarea.
 */
export function useRichEditor(): RichEditorState {
  const current = useSyncExternalStore(subscribe, () => state);
  const missing = current.module === null;
  useEffect(() => {
    if (missing) void loadRichEditor();
  }, [missing]);
  return current;
}

// Loaded when the browser is idle after start, so an editor opened later doesn't wait for it.
if (typeof window !== "undefined") {
  const idle = window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1000));
  idle(() => void loadRichEditor());
}
