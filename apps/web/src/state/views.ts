import type { BoardFilterParams, SavedView } from "@repo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { addView, removeView, renameView } from "~/components/views/views.logic";
import { queryKeys, useSettings } from "./queries";
import { useUpdateSettings } from "./mutations";

const NO_VIEWS: ReadonlyArray<SavedView> = [];

/** The saved views, in the order the user keeps them. They are a server setting, so every browser sees them. */
export function useSavedViews(): ReadonlyArray<SavedView> {
  return useSettings().data?.savedViews ?? NO_VIEWS;
}

/** Saves, renames and deletes views. Each reads the list as the cache has it now, so two quick edits both land. */
export function useViewActions() {
  const queryClient = useQueryClient();
  const { mutate, isPending } = useUpdateSettings();
  const actions = useMemo(() => {
    const current = () => queryClient.getQueryData<{ savedViews: SavedView[] }>(queryKeys.settings)?.savedViews ?? [];
    const write = (savedViews: SavedView[], onSaved?: () => void) => mutate({ savedViews }, { onSuccess: onSaved });
    return {
      save: (name: string, filters: BoardFilterParams, onSaved?: () => void) =>
        write(addView(current(), crypto.randomUUID(), name, filters), onSaved),
      rename: (id: string, name: string, onSaved?: () => void) => write(renameView(current(), id, name), onSaved),
      remove: (id: string) => write(removeView(current(), id)),
    };
  }, [queryClient, mutate]);
  return { ...actions, pending: isPending };
}
