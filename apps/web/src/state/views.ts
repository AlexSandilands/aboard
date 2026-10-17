import type { AppSettings, BoardFilterParams, SavedView } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toastManager } from "~/components/ui/toast";
import { addView, removeView, renameView, restoreView } from "~/components/views/views.logic";
import { queryKeys, useSettings } from "./queries";
import { useUpdateSettings } from "./mutations";

const NO_VIEWS: ReadonlyArray<SavedView> = [];

/** The saved views, in the order the user keeps them. They are a server setting, so every browser sees them. */
export function useSavedViews(): ReadonlyArray<SavedView> {
  return useSettings().data?.savedViews ?? NO_VIEWS;
}

/**
 * Saves, renames and deletes views. Each builds the list from the cache and writes the result there before it is
 * sent, so an edit made before the last one is answered (two quick deletes) builds on it instead of undoing it. A
 * failed save reads the settings again.
 */
export function useViewActions() {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useUpdateSettings();
  const actions = useMemo(() => {
    const current = () => queryClient.getQueryData<AppSettings>(queryKeys.settings)?.savedViews ?? [];
    const write = (savedViews: SavedView[], onSaved?: () => void) => {
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (settings) =>
        settings ? { ...settings, savedViews } : settings,
      );
      mutate(
        { savedViews },
        {
          onSuccess: onSaved,
          onError: () => void queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
        },
      );
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
