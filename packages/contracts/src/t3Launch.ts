import { z } from "zod";

// Shapes for starting a T3 Code thread from a task. They are our own normalized subsets of T3's
// server config (providers, models, settings) and VCS refs, not T3's wire types.

export const T3RuntimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
export type T3RuntimeMode = z.infer<typeof T3RuntimeMode>;

export const T3_RUNTIME_MODES: ReadonlyArray<{ value: T3RuntimeMode; label: string; description: string }> = [
  { value: "approval-required", label: "Supervised", description: "Ask before commands and file changes." },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  { value: "auto", label: "Auto", description: "Supported providers approve routine actions; others still ask." },
  { value: "full-access", label: "Full access", description: "Allow commands and edits without prompts." },
];

export const T3ModelOptionDescriptor = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select"),
    id: z.string(),
    label: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean() })),
    currentValue: z.string().nullable(),
  }),
  z.object({ type: z.literal("boolean"), id: z.string(), label: z.string(), currentValue: z.boolean().nullable() }),
]);
export type T3ModelOptionDescriptor = z.infer<typeof T3ModelOptionDescriptor>;

export const T3LaunchModel = z.object({
  slug: z.string(),
  name: z.string(),
  /** T3 shows a "NEW" badge when this is "new". */
  badge: z.string().nullable(),
  isLegacy: z.boolean(),
  isDefault: z.boolean(),
  options: z.array(T3ModelOptionDescriptor),
});
export type T3LaunchModel = z.infer<typeof T3LaunchModel>;

export const T3LaunchProvider = z.object({
  instanceId: z.string(),
  driver: z.string(),
  displayName: z.string(),
  /** Enabled, available and status "ready": only these models can be picked. */
  ready: z.boolean(),
  message: z.string().nullable(),
  /** Empty means every runtime mode is supported. */
  supportedRuntimeModes: z.array(T3RuntimeMode),
  models: z.array(T3LaunchModel),
});
export type T3LaunchProvider = z.infer<typeof T3LaunchProvider>;

export const T3ModelSelection = z.object({
  instanceId: z.string().min(1),
  model: z.string().min(1),
  options: z.array(z.object({ id: z.string(), value: z.union([z.string(), z.boolean()]) })),
});
export type T3ModelSelection = z.infer<typeof T3ModelSelection>;

export const T3Ref = z.object({
  name: z.string(),
  isRemote: z.boolean(),
  current: z.boolean(),
  isDefault: z.boolean(),
  worktreePath: z.string().nullable(),
});
export type T3Ref = z.infer<typeof T3Ref>;

export const T3EnvMode = z.enum(["local", "worktree"]);
export type T3EnvMode = z.infer<typeof T3EnvMode>;

export const T3LaunchOptions = z.object({
  t3ProjectId: z.string(),
  workspaceRoot: z.string(),
  providers: z.array(T3LaunchProvider),
  favorites: z.array(z.object({ instanceId: z.string(), model: z.string() })),
  /** False when the project folder isn't a git repository: only the current checkout is possible. */
  isRepo: z.boolean(),
  refs: z.array(T3Ref),
  /** The most recently used worktree of another thread in this project. */
  previousWorktree: z.object({ worktreePath: z.string(), branch: z.string().nullable() }).nullable(),
  defaults: z.object({
    modelSelection: T3ModelSelection.nullable(),
    runtimeMode: T3RuntimeMode,
    envMode: T3EnvMode,
    startFromOrigin: z.boolean(),
  }),
});
export type T3LaunchOptions = z.infer<typeof T3LaunchOptions>;

/** Where the new thread runs. Switching branches in the current checkout is deliberately not offered. */
export const T3LaunchWorkspace = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("current") }),
  z.object({ mode: z.literal("new_worktree"), baseRef: z.string().min(1), startFromOrigin: z.boolean() }),
  z.object({
    mode: z.literal("existing_worktree"),
    worktreePath: z.string().min(1),
    branch: z.string().nullable(),
  }),
]);
export type T3LaunchWorkspace = z.infer<typeof T3LaunchWorkspace>;

export const StartT3ThreadInput = z.object({
  /** T3 de-duplicates launches by it: reusing it after a lost response returns the same thread. */
  commandId: z.uuid().optional(),
  prompt: z.string().trim().min(1),
  modelSelection: T3ModelSelection,
  runtimeMode: T3RuntimeMode,
  workspace: T3LaunchWorkspace,
});
export type StartT3ThreadInput = z.infer<typeof StartT3ThreadInput>;
