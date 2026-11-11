import type { AppSettings, UpdateSettingsInput } from "@repo/contracts";

/**
 * The cached settings with a save applied, as the server will store it, so a pick shows at once instead of after the
 * round trip. It mirrors the server's merges (services/settings.ts): the record-shaped fields merge (null puts an
 * operation back to its default), lists and the rest replace. What only the server knows stays as it is until its
 * reply lands: the host name a cleared machine name falls back to, and the token itself (only whether one is set).
 * Normalising (trimming, dropping blank fields) is left to the reply too; nothing here reads those fields back.
 */
export function applySettingsPatch(settings: AppSettings, input: UpdateSettingsInput): AppSettings {
  const {
    handoffMenus,
    operationModels,
    modelTiers,
    notifications,
    backupDir,
    backupRemote,
    machineName,
    t3Token,
    ...replaced
  } = input;
  const next: AppSettings = { ...settings };
  for (const [key, value] of Object.entries(replaced)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (handoffMenus) next.handoffMenus = { ...settings.handoffMenus, ...handoffMenus };
  if (operationModels) {
    const merged = { ...settings.operationModels };
    for (const [op, choice] of Object.entries(operationModels) as Array<
      [keyof typeof merged, (typeof merged)[keyof typeof merged] | null]
    >) {
      if (choice === null) delete merged[op];
      else if (choice !== undefined) merged[op] = choice;
    }
    next.operationModels = merged;
  }
  if (modelTiers) next.modelTiers = { ...settings.modelTiers, ...modelTiers };
  if (notifications) {
    next.notifications = {
      muteInQuietHours: notifications.muteInQuietHours ?? settings.notifications.muteInQuietHours,
      kinds: { ...settings.notifications.kinds, ...notifications.kinds },
    };
  }
  if (backupDir !== undefined) next.backupDir = backupDir || null;
  if (backupRemote !== undefined) next.backupRemote = backupRemote || null;
  if (typeof machineName === "string") {
    next.machineName = machineName;
    next.machineNameIsDefault = false;
  }
  if (t3Token !== undefined) next.t3TokenSet = Boolean(t3Token);
  return next;
}
