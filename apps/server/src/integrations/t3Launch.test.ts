import { EMPTY_MODEL_TIERS, type ModelTiers, type Project } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { ShellSnapshot } from "./t3.ts";
import {
  autoLaunchSettings,
  buildLaunchOptions,
  mapProviders,
  resolveSuggestion,
  resolveT3Project,
  toWorkspaceStrategy,
  WireServerConfig,
  type WireRefs,
} from "./t3Launch.ts";

const t3Project: ShellSnapshot["projects"][number] = {
  id: "t3-p1",
  title: "Acme",
  workspaceRoot: "C:\\Code\\acme",
  defaultModelSelection: null,
};

const config = (settings: Record<string, unknown> = {}, providers?: unknown[]) =>
  WireServerConfig.parse({
    providers: providers ?? [
      {
        instanceId: "codex",
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        status: "error",
        models: [{ slug: "gpt", name: "GPT", isDefault: true }],
      },
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        status: "ready",
        supportedRuntimeModes: ["approval-required", "full-access", "bogus"],
        models: [
          { slug: "custom", name: "Custom", isCustom: true },
          { slug: "opus", name: "Opus", isDefault: true, badge: "new" },
          {
            slug: "sonnet",
            name: "Sonnet",
            isLegacy: true,
            capabilities: {
              optionDescriptors: [
                {
                  type: "select",
                  id: "effort",
                  label: "Effort",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium", isDefault: true },
                  ],
                },
                { type: "boolean", id: "fastMode", label: "Fast mode" },
                { type: "slider", id: "future" },
              ],
            },
          },
        ],
      },
      { instanceId: "off", driver: "codex", enabled: false, status: "ready", models: [] },
    ],
    settings,
  });

const shell = (threads: unknown[] = []): ShellSnapshot =>
  ({ projects: [t3Project], threads, archivedThreads: [] }) as unknown as ShellSnapshot;

const noSuggestion = { suggestedModel: null, modelTiers: EMPTY_MODEL_TIERS };

const repo: WireRefs = { isRepo: true, refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }] };

describe("mapProviders", () => {
  it("keeps enabled providers, flags readiness and maps model options", () => {
    const providers = mapProviders(config());
    expect(providers.map((p) => [p.instanceId, p.displayName, p.ready])).toEqual([
      ["codex", "Codex", false],
      ["claudeAgent", "claudeAgent", true],
    ]);
    const claude = providers[1]!;
    expect(claude.supportedRuntimeModes).toEqual(["approval-required", "full-access"]);
    expect(claude.models[1]).toMatchObject({ slug: "opus", badge: "new", isDefault: true, isLegacy: false });
    expect(claude.models[2]!.options).toEqual([
      {
        type: "select",
        id: "effort",
        label: "Effort",
        options: [
          { id: "low", label: "Low", isDefault: false },
          { id: "medium", label: "Medium", isDefault: true },
        ],
        currentValue: null,
      },
      { type: "boolean", id: "fastMode", label: "Fast mode", currentValue: null },
    ]);
  });
});

describe("buildLaunchOptions defaults", () => {
  const defaults = (settings: Record<string, unknown>, project = t3Project) =>
    buildLaunchOptions({ config: config(settings), refs: repo, shell: shell(), t3Project: project, ...noSuggestion })
      .defaults;

  it("falls back to the first ready provider's default non-custom model", () => {
    expect(defaults({}).modelSelection).toEqual({ instanceId: "claudeAgent", model: "opus", options: [] });
  });

  it("prefers the project override, then T3's legacy project default, then the environment default", () => {
    const env = { defaultModelSelection: { instanceId: "claudeAgent", model: "sonnet" } };
    expect(defaults(env).modelSelection?.model).toBe("sonnet");
    const legacy = { ...t3Project, defaultModelSelection: { instanceId: "claudeAgent", model: "custom" } };
    expect(defaults(env, legacy).modelSelection?.model).toBe("custom");
    expect(defaults({ ...env, projectSettingsFolded: true }, legacy).modelSelection?.model).toBe("sonnet");
    const override = {
      ...env,
      projectSettingsOverrides: {
        "t3-p1": {
          defaultModelSelection: { instanceId: "claudeAgent", model: "opus", options: [{ id: "x", value: true }] },
        },
      },
    };
    expect(defaults(override, legacy).modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "opus",
      options: [{ id: "x", value: true }],
    });
  });

  it("ignores a default on a provider that isn't ready", () => {
    expect(defaults({ defaultModelSelection: { instanceId: "codex", model: "gpt" } }).modelSelection?.model).toBe(
      "opus",
    );
  });

  it("resolves runtime and workspace modes, project overrides first", () => {
    expect(defaults({})).toMatchObject({ runtimeMode: "full-access", envMode: "local", startFromOrigin: true });
    expect(
      defaults({
        defaultRuntimeMode: "auto",
        defaultThreadEnvMode: "worktree",
        newWorktreesStartFromOrigin: false,
        projectSettingsOverrides: { "t3-p1": { defaultRuntimeMode: "approval-required" } },
      }),
    ).toMatchObject({ runtimeMode: "approval-required", envMode: "worktree", startFromOrigin: false });
  });

  it("only offers the current checkout outside a git repo", () => {
    const options = buildLaunchOptions({
      config: config({ defaultThreadEnvMode: "worktree" }),
      refs: null,
      shell: shell([{ id: "t", projectId: "t3-p1", worktreePath: "C:/wt", updatedAt: "2026" }]),
      t3Project,
      ...noSuggestion,
    });
    expect(options).toMatchObject({ isRepo: false, refs: [], previousWorktree: null, defaults: { envMode: "local" } });
  });
});

describe("resolveSuggestion", () => {
  const providers = mapProviders(config());
  const tiers = (t3: ModelTiers["deep"]["t3"]): ModelTiers => ({
    ...EMPTY_MODEL_TIERS,
    deep: { description: null, t3 },
  });
  const sonnet = {
    selection: {
      instanceId: "claudeAgent",
      model: "sonnet",
      options: [
        { id: "effort", value: "low" },
        { id: "effort-gone", value: "x" },
        { id: "fastMode", value: "yes" },
      ],
    },
    label: "Claude Sonnet",
  };

  it("is null without a suggestion", () => {
    expect(resolveSuggestion(null, tiers(sonnet), providers)).toBeNull();
  });

  it("uses the tier's model, dropping options the model doesn't support", () => {
    expect(resolveSuggestion({ tier: "deep", reason: "Risky" }, tiers(sonnet), providers)).toEqual({
      tier: "deep",
      reason: "Risky",
      modelSelection: { instanceId: "claudeAgent", model: "sonnet", options: [{ id: "effort", value: "low" }] },
      unavailable: null,
    });
  });

  it("says why when the tier has no model, its provider isn't ready or the model is gone", () => {
    const why = (t3: ModelTiers["deep"]["t3"]) =>
      resolveSuggestion({ tier: "deep", reason: null }, tiers(t3), providers)?.unavailable;
    expect(why(null)).toBe("No T3 Code model is set for the deep tier in Settings.");
    expect(why({ selection: { instanceId: "codex", model: "gpt", options: [] }, label: "GPT" })).toBe(
      "Codex isn't ready in T3 Code.",
    );
    expect(why({ selection: { instanceId: "claudeAgent", model: "haiku", options: [] }, label: "Haiku" })).toBe(
      "Haiku isn't offered by T3 Code right now.",
    );
    expect(why({ selection: { instanceId: "off", model: "x", options: [] }, label: "Off" })).toBe(
      "Off isn't offered by T3 Code right now.",
    );
  });

  it("is part of the launch options, leaving T3's default alone", () => {
    const options = buildLaunchOptions({
      config: config(),
      refs: repo,
      shell: shell(),
      t3Project,
      suggestedModel: { tier: "deep", reason: null },
      modelTiers: tiers(sonnet),
    });
    expect(options.suggestion?.modelSelection?.model).toBe("sonnet");
    expect(options.defaults.modelSelection?.model).toBe("opus");
  });
});

describe("previous worktree", () => {
  it("picks the newest live thread worktree that isn't the project folder", () => {
    const options = buildLaunchOptions({
      config: config(),
      refs: repo,
      shell: shell([
        { id: "a", projectId: "t3-p1", worktreePath: "C:/wt/old", branch: "t3/old", updatedAt: "2026-01-01" },
        { id: "b", projectId: "t3-p1", worktreePath: "C:/wt/new", branch: "t3/new", updatedAt: "2026-02-01" },
        { id: "c", projectId: "t3-p1", worktreePath: "c:/code/acme/", updatedAt: "2026-03-01" },
        { id: "d", projectId: "t3-p1", worktreePath: "C:/wt/gone", updatedAt: "2026-04-01", archivedAt: "x" },
        { id: "e", projectId: "other", worktreePath: "C:/wt/other", updatedAt: "2026-05-01" },
      ]),
      t3Project,
      ...noSuggestion,
    });
    expect(options.previousWorktree).toEqual({ worktreePath: "C:/wt/new", branch: "t3/new" });
  });
});

describe("resolveT3Project", () => {
  const project = (patch: Partial<Project>): Project => ({
    id: "p",
    title: "Acme",
    workspaceRoot: null,
    workspaceKey: null,
    icon: null,
    t3ProjectId: null,
    reviewSkill: null,
    planSkill: null,
    position: "a0",
    collapsed: false,
    archivedAt: null,
    createdAt: "",
    updatedAt: "",
    ...patch,
  });

  it("matches by stored T3 id, then by folder", () => {
    expect(resolveT3Project(project({ t3ProjectId: "t3-p1" }), shell())?.id).toBe("t3-p1");
    expect(resolveT3Project(project({ workspaceRoot: "c:/code/acme/" }), shell())?.id).toBe("t3-p1");
    expect(resolveT3Project(project({ workspaceRoot: "c:/code/other" }), shell())).toBeNull();
    expect(resolveT3Project(project({}), shell())).toBeNull();
  });
});

describe("toWorkspaceStrategy", () => {
  it("maps each workspace choice to T3's strategy", () => {
    expect(toWorkspaceStrategy({ mode: "current" })).toEqual({ type: "root" });
    expect(toWorkspaceStrategy({ mode: "new_worktree", baseRef: "origin/main", startFromOrigin: false })).toEqual({
      type: "worktree",
      baseRef: "origin/main",
      startFromOrigin: false,
    });
    expect(toWorkspaceStrategy({ mode: "existing_worktree", worktreePath: "C:/wt", branch: "t3/x" })).toEqual({
      type: "existing_worktree",
      worktreePath: "C:/wt",
      branch: "t3/x",
    });
    expect(toWorkspaceStrategy({ mode: "existing_worktree", worktreePath: "C:/wt", branch: null })).toEqual({
      type: "existing_worktree",
      worktreePath: "C:/wt",
    });
  });
});

describe("autoLaunchSettings", () => {
  const sonnet = { selection: { instanceId: "claudeAgent", model: "sonnet", options: [] }, label: "Sonnet" };
  const options = (opts: { settings?: Record<string, unknown>; refs?: WireRefs | null; suggest?: boolean } = {}) =>
    buildLaunchOptions({
      config: config(opts.settings ?? {}),
      refs: opts.refs === undefined ? repo : opts.refs,
      shell: shell(),
      t3Project,
      suggestedModel: opts.suggest ? { tier: "light", reason: null } : null,
      modelTiers: { ...EMPTY_MODEL_TIERS, light: { description: null, t3: sonnet } },
    });

  it("starts work on the suggested model in a new worktree from the default branch", () => {
    expect(autoLaunchSettings(options({ suggest: true }), { work: true })).toEqual({
      ok: true,
      launch: {
        modelSelection: sonnet.selection,
        runtimeMode: "full-access",
        workspace: { mode: "new_worktree", baseRef: "main", startFromOrigin: true },
      },
    });
  });

  it("plans on T3's default model, and never takes more access than T3's default", () => {
    // The provider offers approval-required and full-access; T3's default, auto, sits between them.
    const result = autoLaunchSettings(options({ suggest: true, settings: { defaultRuntimeMode: "auto" } }), {
      work: false,
    });
    expect(result).toMatchObject({
      ok: true,
      launch: { modelSelection: { model: "opus" }, runtimeMode: "approval-required" },
    });
  });

  it("lowers the access to an automation's ceiling but never raises it past T3's default", () => {
    const mode = (settings: Record<string, unknown>, maxRuntimeMode: "approval-required" | "full-access") => {
      const result = autoLaunchSettings(options({ settings }), { work: true, maxRuntimeMode });
      return result.ok ? result.launch.runtimeMode : result.reason;
    };
    expect(mode({ defaultRuntimeMode: "full-access" }, "approval-required")).toBe("approval-required");
    expect(mode({ defaultRuntimeMode: "approval-required" }, "full-access")).toBe("approval-required");
    expect(mode({ defaultRuntimeMode: "full-access" }, "full-access")).toBe("full-access");
  });

  it("branches from the given ref locally unless told to use origin's copy", () => {
    const refs: WireRefs = {
      isRepo: true,
      refs: [
        { name: "main", current: true, isDefault: true, worktreePath: null },
        { name: "origin/feat/a", isRemote: true, current: false, isDefault: false, worktreePath: null },
      ],
    };
    const workspace = (choice: { baseRef?: string; startFromOrigin?: boolean }) => {
      const result = autoLaunchSettings(options({ refs }), { work: true, ...choice });
      return result.ok ? result.launch.workspace : result.reason;
    };
    expect(workspace({ baseRef: "origin/feat/a" })).toEqual({
      mode: "new_worktree",
      baseRef: "origin/feat/a",
      startFromOrigin: false,
    });
    expect(workspace({ baseRef: "feat/b" })).toEqual({
      mode: "new_worktree",
      baseRef: "feat/b",
      startFromOrigin: false,
    });
    expect(workspace({ baseRef: "feat/b", startFromOrigin: true })).toEqual({
      mode: "new_worktree",
      baseRef: "feat/b",
      startFromOrigin: true,
    });
  });

  it("runs in the folder itself when it isn't a git repository", () => {
    const notRepo = options({ refs: { isRepo: false, refs: [] } });
    expect(autoLaunchSettings(notRepo, { work: true })).toMatchObject({
      ok: true,
      launch: { workspace: { mode: "current" } },
    });
    expect(autoLaunchSettings(notRepo, { work: true, baseRef: "main" })).toEqual({
      ok: false,
      reason: `${t3Project.workspaceRoot} isn't a git repository, so a thread can't branch from main`,
    });
  });

  it("explains when no model is ready", () => {
    const none = buildLaunchOptions({
      config: config({}, []),
      refs: repo,
      shell: shell(),
      t3Project,
      ...noSuggestion,
    });
    expect(autoLaunchSettings(none, { work: true })).toEqual({
      ok: false,
      reason: "T3 Code has no model ready to start a thread",
    });
  });
});
