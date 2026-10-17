import type { AppSettings, BoardFilterParams, SavedView } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toastManager } from "~/components/ui/toast";
import { addView, removeView, renameView, restoreView } from "~/components/views/views.logic";
import { queryKeys, useSettings } from "./queries";
import { api } from "~/lib/api";

const NO_VIEWS: ReadonlyArray<SavedView> = [];

/** The saved views, in the order the user keeps them. They are a server setting, so every browser sees them. */
export function useSavedViews(): ReadonlyArray<SavedView> {
  return useSettings().data?.savedViews ?? NO_VIEWS;
}

/**
 * Saves, renames and deletes views. Each builds the list from the cache and writes the result there before it is
 * sent, so an edit made before the last one is answered (two quick deletes) builds on it instead of undoing it.
 * The saves share a scope, so they reach the server in order, and the server's reply isn't written back (it would
 * show the list as it was before a later edit); a failed save reads the settings again.
 */
export function useViewActions() {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useMutation({
    mutationFn: (savedViews: SavedView[]) =>
      api<AppSettings>("/api/settings", { method: "PATCH", body: { savedViews } }),
    scope: { id: "saved-views" },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      toastManager.add({
        type: "error",
        title: "Couldn't save the views",
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const actions = useMemo(() => {
    const current = () => queryClient.getQueryData<AppSettings>(queryKeys.settings)?.savedViews ?? [];
    const write = (savedViews: SavedView[], onSaved?: () => void) => {
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (settings) =>
        settings ? { ...settings, savedViews } : settings,
      );
      mutate(savedViews, { onSuccess: onSaved });
    };
    return {
      save: (name: string, filters: BoardFilterParams, onSaved?: () => void) =>
        write(addView(current(), crypto.randomUUID(), name, filters), onSaved),
      rename: (id: string, name: string, onSaved?: () => void) => write(renameView(current(), id, name), onSaved),
      remove: (id: string) => {
        const views = current();
        const index = views.findIndex((v) => v.id === id);
        const view = views[index];
        if (!view) return;
        write(removeView(views, id));
        toastManager.add({
          type: "info",
          title: `Deleted view "${view.name}"`,
          actionProps: { children: "Undo", onClick: () => write(restoreView(current(), view, index)) },
        });
      },
    };
  }, [queryClient, mutate]);
  return { ...actions, pending: isPending };
}
