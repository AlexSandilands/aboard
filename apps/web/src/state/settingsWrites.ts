import type { AppSettings, UpdateSettingsInput } from "@repo/contracts";
import type { MutationOptions, QueryClient } from "@tanstack/react-query";
import { applySettingsPatch } from "./settingsPatch.logic";

/** The settings query's key (queryKeys.settings). */
export const SETTINGS_QUERY_KEY = ["settings"] as const;
/** Every settings write carries this key, so whatever puts a server copy in the cache can find the ones in flight. */
export const SETTINGS_WRITE_KEY = ["settingsWrite"] as const;

/**
 * `settings` with every settings write still in flight applied on top, oldest first. Writes are optimistic, so
 * anything that puts a server copy in the cache (a write's reply, a refetch, an event) goes through this, or it would
 * show an edit the server hasn't had yet as undone until that edit's own reply lands. `except` is the write whose
 * reply `settings` is, still pending while its onSuccess runs.
 */
export function withPendingSettingsWrites(
  queryClient: QueryClient,
  settings: AppSettings,
  except?: UpdateSettingsInput,
): AppSettings {
  return queryClient
    .getMutationCache()
    .findAll({ mutationKey: SETTINGS_WRITE_KEY, status: "pending" })
    .map((mutation) => mutation.state.variables as UpdateSettingsInput | undefined)
    .reduce<AppSettings>(
      (current, input) => (input && input !== except ? applySettingsPatch(current, input) : current),
      settings,
    );
}

/**
 * A settings write: the cache is patched at once, so a pick shows before the server answers. Every write shares one
 * scope, so they reach the server in the order they were made, and each reply goes into the cache with the writes
 * still behind it applied on top. A failed write reads the settings again, which drops it and keeps the others.
 */
export function settingsWriteOptions(
  queryClient: QueryClient,
  save: (input: UpdateSettingsInput) => Promise<AppSettings>,
  onFailed: (error: Error) => void,
): MutationOptions<AppSettings, Error, UpdateSettingsInput> {
  return {
    mutationKey: SETTINGS_WRITE_KEY,
    mutationFn: save,
    scope: { id: "settings" },
    // Not async: the cache has to change inside mutate(), so a writer that reads it next builds on this edit. The
    // cancel reverts a refetch in flight synchronously, before the patch, so it can't land on top of it.
    onMutate: (input) => {
      void queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
      queryClient.setQueryData<AppSettings>(SETTINGS_QUERY_KEY, (settings) =>
        settings ? applySettingsPatch(settings, input) : settings,
      );
    },
    onSuccess: (settings, input) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, withPendingSettingsWrites(queryClient, settings, input));
    },
    // Here rather than in mutate()'s options: those only run for the latest call, and a save can be queued behind.
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      onFailed(error);
    },
  };
}
