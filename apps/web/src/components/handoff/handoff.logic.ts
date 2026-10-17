import {
  defaultBaseRef,
  type AppSettings,
  type Project,
  type T3IntegrationStatus,
  type T3LaunchModel,
  type T3LaunchOptions,
  type T3LaunchProvider,
  type T3LaunchWorkspace,
  type T3ModelSelection,
  type T3Ref,
  type TaskSummary,
} from "@repo/contracts";

/** Hand-off actions belong to work that's still open. An epic's hand-off orchestrates its tasks. */
export function showHandoffActions(task: Pick<TaskSummary, "status" | "archivedAt">): boolean {
  return task.status !== "done" && task.archivedAt === null;
}

/**
 * "New T3 Code thread" needs a running T3, a token and a project T3 could know (by id or folder). A task
 * can have several threads (a follow-up for conflicts, a review, …), so linked ones don't hide it. Whether T3 really has the project is only known once the dialog loads its options.
 */
export function canStartT3Thread(
  task: Pick<TaskSummary, "status" | "archivedAt">,
  project: Pick<Project, "t3ProjectId" | "workspaceRoot"> | undefined,
  t3: Pick<T3IntegrationStatus, "detected">,
  settings: Pick<AppSettings, "t3TokenSet"> | undefined,
): boolean {
  return showHandoffActions(task) && canStartProjectT3Thread(project, t3, settings);
}

/** A thread about a project as a whole (Suggest epics) needs the same: a running T3, a token, a folder. */
export function canStartProjectT3Thread(
  project: Pick<Project, "t3ProjectId" | "workspaceRoot"> | undefined,
  t3: Pick<T3IntegrationStatus, "detected">,
  settings: Pick<AppSettings, "t3TokenSet"> | undefined,
): boolean {
  return t3.detected && settings?.t3TokenSet === true && !!(project?.t3ProjectId || project?.workspaceRoot);
}

/**
 * Whether a failed launch may be retried with the same commandId. Keep it whenever T3 may already have
 * accepted the launch, since T3 replays an accepted command instead of starting a second thread: an
 * unreachable/timeout error, a result the board couldn't read (`protocol-after-send`), or an error with no
 * details at all (the board's own response was lost). The dialog also keeps it for non-ApiError failures such
 * as a fetch TypeError, which mean the response never arrived. A command T3 rejected stays rejected under that id,
 * so any other tagged error needs a fresh one.
 */
export function keepsCommandId(details: unknown): boolean {
  if (details == null) return true;
  const tag = (details as { t3?: unknown }).t3;
  return tag === "unreachable" || tag === "protocol-after-send";
}

// ── Models ───────────────────────────────────────────────────────────────

export const FAVORITES = "favorites";

export interface PickerModel {
  provider: T3LaunchProvider;
  model: T3LaunchModel;
}

/** One entry per (provider, model), favorites first, mirroring T3's picker ordering. */
function allModels(options: Pick<T3LaunchOptions, "providers">): PickerModel[] {
  return options.providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
}

const isFavorite = (options: Pick<T3LaunchOptions, "favorites">, entry: PickerModel) =>
  options.favorites.some((f) => f.instanceId === entry.provider.instanceId && f.model === entry.model.slug);

/**
 * The picker list for a rail tab ("favorites" or a provider id) and a search query. Searching spans every
 * provider. Legacy models of a provider tab are split out into their own collapsible section.
 */
export function pickerModels(
  options: Pick<T3LaunchOptions, "providers" | "favorites">,
  tab: string,
  query: string,
): { models: PickerModel[]; legacy: PickerModel[] } {
  const q = query.trim().toLowerCase();
  const all = allModels(options);
  if (q) {
    const matches = all.filter(
      (e) =>
        e.model.name.toLowerCase().includes(q) ||
        e.model.slug.toLowerCase().includes(q) ||
        e.provider.displayName.toLowerCase().includes(q),
    );
    return { models: matches, legacy: [] };
  }
  if (tab === FAVORITES) return { models: all.filter((e) => isFavorite(options, e)), legacy: [] };
  const own = all.filter((e) => e.provider.instanceId === tab);
  return { models: own.filter((e) => !e.model.isLegacy), legacy: own.filter((e) => e.model.isLegacy) };
}

/** The rail tab the picker opens on: favorites when there are any, else the selected model's provider. */
export function initialPickerTab(
  options: Pick<T3LaunchOptions, "favorites" | "providers">,
  selection: T3ModelSelection | null,
) {
  if (options.favorites.length > 0) return FAVORITES;
  return selection?.instanceId ?? options.providers[0]?.instanceId ?? FAVORITES;
}

export function findModel(
  options: Pick<T3LaunchOptions, "providers">,
  selection: Pick<T3ModelSelection, "instanceId" | "model"> | null,
): PickerModel | null {
  if (!selection) return null;
  const provider = options.providers.find((p) => p.instanceId === selection.instanceId);
  const model = provider?.models.find((m) => m.slug === selection.model);
  return provider && model ? { provider, model } : null;
}

/** The value an option starts with: the descriptor's current value, else its default option. */
export function defaultOptionValue(descriptor: T3LaunchModel["options"][number]): string | boolean | null {
  if (descriptor.type === "boolean") return descriptor.currentValue;
  return descriptor.currentValue ?? descriptor.options.find((o) => o.isDefault)?.id ?? null;
}

/** The effective value of a model option in a selection, falling back to its default. */
export function optionValue(
  selection: T3ModelSelection,
  descriptor: T3LaunchModel["options"][number],
): string | boolean | null {
  return selection.options.find((o) => o.id === descriptor.id)?.value ?? defaultOptionValue(descriptor);
}

/** Selects a model, keeping option values the new model also supports. */
export function selectModel(previous: T3ModelSelection | null, entry: PickerModel): T3ModelSelection {
  const options = entry.model.options.flatMap((descriptor) => {
    const kept = previous?.options.find((o) => o.id === descriptor.id);
    const valid =
      kept &&
      (descriptor.type === "boolean"
        ? typeof kept.value === "boolean"
        : descriptor.options.some((o) => o.id === kept.value));
    return valid ? [kept] : [];
  });
  return { instanceId: entry.provider.instanceId, model: entry.model.slug, options };
}

export function setOption(selection: T3ModelSelection, id: string, value: string | boolean): T3ModelSelection {
  return { ...selection, options: [...selection.options.filter((o) => o.id !== id), { id, value }] };
}

/** T3's effort control is the model's first select option; fast mode is a boolean named fastMode. */
export function modelTraits(model: T3LaunchModel | undefined) {
  const select = model?.options.find((o) => o.type === "select") ?? null;
  const fastMode = model?.options.find((o) => o.type === "boolean" && o.id === "fastMode") ?? null;
  return { effort: select?.type === "select" ? select : null, fastMode };
}

/**
 * The model a launch starts on: the task's suggested tier's model when working and it resolved, else T3's
 * default. Planning ignores the suggestion; the tier is about implementing.
 */
export function launchModelSelection(
  options: Pick<T3LaunchOptions, "suggestion" | "defaults">,
  planWithMe: boolean,
): T3ModelSelection | null {
  if (!planWithMe && options.suggestion?.modelSelection) return options.suggestion.modelSelection;
  return options.defaults.modelSelection;
}

const sameSelection = (a: T3ModelSelection | null, b: T3ModelSelection | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * The selection after toggling "Plan with me": swapped to the new mode's model, unless the user already picked
 * a model by hand, which is kept.
 */
export function selectionAfterPlanToggle(
  options: Pick<T3LaunchOptions, "suggestion" | "defaults">,
  current: T3ModelSelection | null,
  nextPlanWithMe: boolean,
): T3ModelSelection | null {
  if (!sameSelection(current, launchModelSelection(options, !nextPlanWithMe))) return current;
  return launchModelSelection(options, nextPlanWithMe);
}

/**
 * How a model tier's T3 model is named in prompts and settings, e.g. "Claude Sonnet 5.5, High, fast". Only
 * options set explicitly are named; the model's defaults go unsaid.
 */
export function selectionLabel(catalog: Pick<T3LaunchOptions, "providers">, selection: T3ModelSelection): string {
  const found = findModel(catalog, selection);
  if (!found) return selection.model;
  const { effort, fastMode } = modelTraits(found.model);
  const parts = [found.model.name];
  const effortId = effort ? selection.options.find((o) => o.id === effort.id)?.value : undefined;
  const effortLabel = effort?.options.find((o) => o.id === effortId)?.label;
  if (effortLabel) parts.push(effortLabel);
  if (fastMode && selection.options.some((o) => o.id === fastMode.id && o.value === true)) parts.push("fast");
  return parts.join(", ");
}

// ── Workspace and refs ───────────────────────────────────────────────────

export type WorkspaceMode = "current" | "new_worktree" | "previous";

export interface WorkspaceChoice {
  mode: WorkspaceMode;
  /** Selected ref name; null means the default for the mode. */
  ref: string | null;
}

const samePath = (a: string, b: string) =>
  a
    .replace(/[\\/]+$/, "")
    .replaceAll("\\", "/")
    .toLowerCase() ===
  b
    .replace(/[\\/]+$/, "")
    .replaceAll("\\", "/")
    .toLowerCase();

/** A ref checked out in a worktree other than the project folder. */
export function refWorktree(ref: T3Ref, workspaceRoot: string): string | null {
  return ref.worktreePath && !samePath(ref.worktreePath, workspaceRoot) ? ref.worktreePath : null;
}

/** T3's badge order: current, then worktree, then remote, then default. */
export function refBadge(ref: T3Ref, workspaceRoot: string): "current" | "worktree" | "remote" | "default" | null {
  if (ref.current) return "current";
  if (refWorktree(ref, workspaceRoot)) return "worktree";
  if (ref.isRemote) return "remote";
  if (ref.isDefault) return "default";
  return null;
}

/**
 * Under Current checkout only refs that need no checkout can be picked: the current branch, or a branch
 * with its own worktree (which runs there). Switching the project folder's branch is deliberately not done.
 */
export function refDisabledReason(ref: T3Ref, mode: WorkspaceMode, workspaceRoot: string): string | null {
  if (mode !== "current" || ref.current || refWorktree(ref, workspaceRoot)) return null;
  return "Switching branches in the current checkout isn't supported. Use New worktree to branch from it.";
}

/**
 * The workspace the dialog opens with. A task of an integration epic starts in a new worktree from its epic's branch
 * (origin's copy when T3 lists it), since its pull request goes there; anything else follows T3's settings.
 */
export function initialWorkspaceChoice(
  options: Pick<T3LaunchOptions, "isRepo" | "defaults"> & Partial<Pick<T3LaunchOptions, "refs">>,
  integrationBranch: string | null = null,
): WorkspaceChoice {
  if (options.isRepo && integrationBranch) {
    const refs = options.refs ?? [];
    const ref =
      refs.find((r) => r.isRemote && r.name === `origin/${integrationBranch}`) ??
      refs.find((r) => !r.isRemote && r.name === integrationBranch);
    if (ref) return { mode: "new_worktree", ref: ref.name };
  }
  return { mode: options.isRepo && options.defaults.envMode === "worktree" ? "new_worktree" : "current", ref: null };
}

export function selectedRef(options: Pick<T3LaunchOptions, "refs">, choice: WorkspaceChoice): T3Ref | undefined {
  if (choice.ref) return options.refs.find((r) => r.name === choice.ref);
  return choice.mode === "new_worktree" ? defaultBaseRef(options.refs) : options.refs.find((r) => r.current);
}

/** What the launch request sends for a workspace choice. Null when the choice can't be launched. */
export function toLaunchWorkspace(
  options: Pick<T3LaunchOptions, "refs" | "previousWorktree" | "workspaceRoot" | "defaults">,
  choice: WorkspaceChoice,
): T3LaunchWorkspace | null {
  if (choice.mode === "previous") {
    const previous = options.previousWorktree;
    return previous
      ? { mode: "existing_worktree", worktreePath: previous.worktreePath, branch: previous.branch }
      : null;
  }
  const ref = selectedRef(options, choice);
  if (choice.mode === "new_worktree") {
    if (!ref) return null;
    // A remote ref already names the origin commit; "start from origin" only applies to local branches.
    return {
      mode: "new_worktree",
      baseRef: ref.name,
      startFromOrigin: options.defaults.startFromOrigin && !ref.isRemote,
    };
  }
  const worktree = ref ? refWorktree(ref, options.workspaceRoot) : null;
  if (worktree) return { mode: "existing_worktree", worktreePath: worktree, branch: ref!.name };
  if (ref && refDisabledReason(ref, "current", options.workspaceRoot)) return null;
  return { mode: "current" };
}

export const WORKSPACE_LABELS: Record<WorkspaceMode, string> = {
  current: "Current checkout",
  new_worktree: "New worktree",
  previous: "Previous worktree",
};

/** The workspace trigger label; picking a ref with its own worktree under Current checkout runs there. */
export function workspaceLabel(
  options: Pick<T3LaunchOptions, "refs" | "workspaceRoot">,
  choice: WorkspaceChoice,
): string {
  if (choice.mode === "current") {
    const ref = selectedRef(options, choice);
    if (ref && refWorktree(ref, options.workspaceRoot)) return "Current worktree";
  }
  return WORKSPACE_LABELS[choice.mode];
}

/** The ref trigger label: "From <ref>" for a new worktree (origin/ when starting from origin). */
export function refLabel(
  options: Pick<T3LaunchOptions, "refs" | "previousWorktree" | "defaults">,
  choice: WorkspaceChoice,
): string {
  if (choice.mode === "previous") return options.previousWorktree?.branch ?? "detached";
  const ref = selectedRef(options, choice);
  if (!ref) return "No branch";
  if (choice.mode !== "new_worktree") return ref.name;
  return `From ${options.defaults.startFromOrigin && !ref.isRemote ? `origin/${ref.name}` : ref.name}`;
}
