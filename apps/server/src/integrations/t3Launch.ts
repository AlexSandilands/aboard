import {
  normalizeWorkspaceKey,
  T3RuntimeMode,
  type ModelTiers,
  type Project,
  type SuggestedModel,
  type T3EnvMode,
  type T3LaunchModel,
  type T3LaunchOptions,
  type T3LaunchProvider,
  type T3LaunchSuggestion,
  type T3LaunchWorkspace,
  type T3ModelOptionDescriptor,
  type T3ModelSelection,
  type T3Ref,
} from "@repo/contracts";
import { z } from "zod";
import type { ShellSnapshot } from "./t3.ts";

// ── Wire shapes (lenient subsets of T3 Code's server config and VCS contracts) ──

const WireModelSelection = z.object({
  instanceId: z.string(),
  model: z.string(),
  options: z
    .array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) }))
    .nullish()
    .catch(null),
});

const WireDescriptor = z.union([
  z.object({
    type: z.literal("select"),
    id: z.string(),
    label: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean().nullish() })),
    currentValue: z.string().nullish(),
  }),
  z.object({ type: z.literal("boolean"), id: z.string(), label: z.string(), currentValue: z.boolean().nullish() }),
]);

const WireModel = z.object({
  slug: z.string(),
  name: z.string(),
  badge: z.string().nullish(),
  isCustom: z.boolean().nullish(),
  isDefault: z.boolean().nullish(),
  isLegacy: z.boolean().nullish(),
  capabilities: z
    .object({ optionDescriptors: z.array(z.unknown()).nullish() })
    .nullish()
    .catch(null),
});

const WireProvider = z.object({
  instanceId: z.string(),
  driver: z.string(),
  displayName: z.string().nullish(),
  enabled: z.boolean(),
  status: z.string(),
  availability: z.string().nullish(),
  message: z.string().nullish(),
  supportedRuntimeModes: z.array(z.string()).nullish(),
  models: z.array(WireModel),
});

const WireProjectOverrides = z
  .object({
    defaultModelSelection: WireModelSelection.nullish().catch(null),
    defaultRuntimeMode: T3RuntimeMode.nullish().catch(null),
    defaultThreadEnvMode: z.enum(["local", "worktree"]).nullish().catch(null),
    newWorktreesStartFromOrigin: z.boolean().nullish().catch(null),
  })
  .loose();

const WireSettings = z
  .object({
    favorites: z
      .array(z.object({ provider: z.string(), model: z.string() }))
      .nullish()
      .catch(null),
    defaultModelSelection: WireModelSelection.nullish().catch(null),
    defaultRuntimeMode: T3RuntimeMode.nullish().catch(null),
    defaultThreadEnvMode: z.enum(["local", "worktree"]).nullish().catch(null),
    newWorktreesStartFromOrigin: z.boolean().nullish().catch(null),
    projectSettingsOverrides: z.record(z.string(), WireProjectOverrides).nullish().catch(null),
    projectSettingsFolded: z.boolean().nullish().catch(null),
  })
  .loose();

/** Subset of T3's `server.getConfig` result. */
export const WireServerConfig = z.object({ providers: z.array(WireProvider), settings: WireSettings });
export type WireServerConfig = z.infer<typeof WireServerConfig>;

/** Subset of T3's `vcs.listRefs` result. */
export const WireRefs = z.object({
  isRepo: z.boolean(),
  refs: z.array(
    z.object({
      name: z.string(),
      isRemote: z.boolean().nullish(),
      current: z.boolean(),
      isDefault: z.boolean(),
      worktreePath: z.string().nullable(),
    }),
  ),
});
export type WireRefs = z.infer<typeof WireRefs>;

/** Subset of T3's `orchestration.launchThread` result. */
export const WireLaunchResult = z.object({ threadId: z.string().min(1) }).loose();

// ── Pure mapping ─────────────────────────────────────────────────────────

/** The T3 project for a board project: its stored T3 id, else the T3 project with the same folder. */
export function resolveT3Project(project: Project, shell: ShellSnapshot): ShellSnapshot["projects"][number] | null {
  if (project.t3ProjectId) {
    const byId = shell.projects.find((p) => p.id === project.t3ProjectId);
    if (byId) return byId;
  }
  const key = project.workspaceKey ?? (project.workspaceRoot ? normalizeWorkspaceKey(project.workspaceRoot) : null);
  if (!key) return null;
  return shell.projects.find((p) => normalizeWorkspaceKey(p.workspaceRoot) === key) ?? null;
}

function mapDescriptor(raw: unknown): T3ModelOptionDescriptor | null {
  const parsed = WireDescriptor.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  if (d.type === "boolean") return { type: "boolean", id: d.id, label: d.label, currentValue: d.currentValue ?? null };
  return {
    type: "select",
    id: d.id,
    label: d.label,
    options: d.options.map((o) => ({ id: o.id, label: o.label, isDefault: o.isDefault ?? false })),
    currentValue: d.currentValue ?? null,
  };
}

function mapModel(model: z.infer<typeof WireModel>): T3LaunchModel {
  return {
    slug: model.slug,
    name: model.name,
    badge: model.badge ?? null,
    isLegacy: model.isLegacy ?? false,
    isDefault: model.isDefault ?? false,
    options: (model.capabilities?.optionDescriptors ?? []).map(mapDescriptor).filter((d) => d !== null),
  };
}

/** Enabled providers only, as T3's picker rail shows them. Custom models are kept; T3 lists them too. */
export function mapProviders(config: WireServerConfig): T3LaunchProvider[] {
  return config.providers
    .filter((p) => p.enabled)
    .map((p) => ({
      instanceId: p.instanceId,
      driver: p.driver,
      displayName: p.displayName ?? p.instanceId,
      ready: p.status === "ready" && p.availability !== "unavailable",
      message: p.message ?? null,
      supportedRuntimeModes: (p.supportedRuntimeModes ?? []).filter(
        (m): m is T3RuntimeMode => T3RuntimeMode.safeParse(m).success,
      ),
      models: p.models.map(mapModel),
    }));
}

export const mapFavorites = (config: WireServerConfig): T3LaunchOptions["favorites"] =>
  (config.settings.favorites ?? []).map((f) => ({ instanceId: f.provider, model: f.model }));

/**
 * The model a new thread starts with, mirroring T3's new-thread defaults: the project's default model
 * (T3's legacy per-project field until its settings fold), else the environment default, kept only when
 * its provider is ready; otherwise the first ready provider's default (non-custom) model.
 */
export function defaultModelSelection(
  config: WireServerConfig,
  providers: ReadonlyArray<T3LaunchProvider>,
  t3Project: ShellSnapshot["projects"][number],
): T3ModelSelection | null {
  const settings = config.settings;
  const override = settings.projectSettingsOverrides?.[t3Project.id]?.defaultModelSelection;
  const legacy = settings.projectSettingsFolded
    ? null
    : WireModelSelection.nullish().catch(null).parse(t3Project.defaultModelSelection);
  const preferred = override ?? legacy ?? settings.defaultModelSelection ?? null;
  if (preferred) {
    const provider = providers.find((p) => p.instanceId === preferred.instanceId && p.ready);
    if (provider?.models.some((m) => m.slug === preferred.model)) {
      return { instanceId: preferred.instanceId, model: preferred.model, options: preferred.options ?? [] };
    }
  }
  const raw = new Map(config.providers.map((p) => [p.instanceId, p]));
  for (const provider of providers) {
    if (!provider.ready) continue;
    const models = raw.get(provider.instanceId)?.models.filter((m) => !m.isCustom) ?? [];
    const model = models.find((m) => m.isDefault) ?? models[0];
    if (model) return { instanceId: provider.instanceId, model: model.slug, options: [] };
  }
  return null;
}

/**
 * The task's suggested tier resolved against the tier settings and T3's providers. The tier's model is used
 * only when its provider is ready and still offers it; option values the model no longer supports are dropped.
 */
export function resolveSuggestion(
  suggested: SuggestedModel | null,
  modelTiers: ModelTiers,
  providers: ReadonlyArray<T3LaunchProvider>,
): T3LaunchSuggestion | null {
  if (!suggested) return null;
  const unavailable = (why: string): T3LaunchSuggestion => ({ ...suggested, modelSelection: null, unavailable: why });
  const binding = modelTiers[suggested.tier].t3;
  if (!binding) return unavailable(`No T3 Code model is set for the ${suggested.tier} tier in Settings.`);
  const provider = providers.find((p) => p.instanceId === binding.selection.instanceId);
  if (!provider) return unavailable(`${binding.label} isn't offered by T3 Code right now.`);
  if (!provider.ready) return unavailable(`${provider.displayName} isn't ready in T3 Code.`);
  const model = provider.models.find((m) => m.slug === binding.selection.model);
  if (!model) return unavailable(`${binding.label} isn't offered by T3 Code right now.`);
  const options = binding.selection.options.filter((o) => {
    const descriptor = model.options.find((d) => d.id === o.id);
    if (!descriptor) return false;
    return descriptor.type === "boolean"
      ? typeof o.value === "boolean"
      : descriptor.options.some((choice) => choice.id === o.value);
  });
  return { ...suggested, modelSelection: { ...binding.selection, options }, unavailable: null };
}

/** The newest live thread in the project that ran in a worktree other than the project folder. */
export function previousWorktree(
  shell: ShellSnapshot,
  t3Project: ShellSnapshot["projects"][number],
): T3LaunchOptions["previousWorktree"] {
  const rootKey = normalizeWorkspaceKey(t3Project.workspaceRoot);
  const candidates = shell.threads
    .filter((t) => t.projectId === t3Project.id && t.worktreePath && !t.archivedAt)
    .filter((t) => normalizeWorkspaceKey(t.worktreePath!) !== rootKey)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const latest = candidates[0];
  return latest ? { worktreePath: latest.worktreePath!, branch: latest.branch ?? null } : null;
}

export function buildLaunchOptions(input: {
  config: WireServerConfig;
  refs: WireRefs | null;
  shell: ShellSnapshot;
  t3Project: ShellSnapshot["projects"][number];
  suggestedModel: SuggestedModel | null;
  modelTiers: ModelTiers;
}): T3LaunchOptions {
  const { config, shell, t3Project } = input;
  const settings = config.settings;
  const override = settings.projectSettingsOverrides?.[t3Project.id];
  const providers = mapProviders(config);
  const refs: T3Ref[] = (input.refs?.refs ?? []).map((r) => ({
    name: r.name,
    isRemote: r.isRemote ?? false,
    current: r.current,
    isDefault: r.isDefault,
    worktreePath: r.worktreePath,
  }));
  const isRepo = input.refs?.isRepo ?? false;
  const envMode: T3EnvMode = isRepo
    ? (override?.defaultThreadEnvMode ?? settings.defaultThreadEnvMode ?? "local")
    : "local";
  return {
    t3ProjectId: t3Project.id,
    workspaceRoot: t3Project.workspaceRoot,
    providers,
    favorites: mapFavorites(config),
    isRepo,
    refs,
    previousWorktree: isRepo ? previousWorktree(shell, t3Project) : null,
    suggestion: resolveSuggestion(input.suggestedModel, input.modelTiers, providers),
    defaults: {
      modelSelection: defaultModelSelection(config, providers, t3Project),
      runtimeMode: override?.defaultRuntimeMode ?? settings.defaultRuntimeMode ?? "full-access",
      envMode,
      startFromOrigin: override?.newWorktreesStartFromOrigin ?? settings.newWorktreesStartFromOrigin ?? true,
    },
  };
}

/** T3's `workspaceStrategy` for a launch. The current checkout never switches branch (see the hand-off doc). */
export function toWorkspaceStrategy(workspace: T3LaunchWorkspace): Record<string, unknown> {
  switch (workspace.mode) {
    case "current":
      return { type: "root" };
    case "new_worktree":
      return { type: "worktree", baseRef: workspace.baseRef, startFromOrigin: workspace.startFromOrigin };
    case "existing_worktree":
      return {
        type: "existing_worktree",
        worktreePath: workspace.worktreePath,
        ...(workspace.branch ? { branch: workspace.branch } : {}),
      };
  }
}
