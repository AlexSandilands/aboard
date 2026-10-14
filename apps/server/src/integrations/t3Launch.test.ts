import type { Project } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import type { ShellSnapshot } from "./t3.ts";
import {
  buildLaunchOptions,
  mapProviders,
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
        showInteractionModeToggle: false,
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

const repo: WireRefs = { isRepo: true, refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }] };

describe("mapProviders", () => {
  it("keeps enabled providers, flags readiness and maps model options", () => {
    const providers = mapProviders(config());
    expect(providers.map((p) => [p.instanceId, p.displayName, p.ready, p.supportsPlanMode])).toEqual([
      ["codex", "Codex", false, false],
      ["claudeAgent", "claudeAgent", true, true],
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
    buildLaunchOptions({ config: config(settings), refs: repo, shell: shell(), t3Project: project }).defaults;

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
    });
    expect(options).toMatchObject({ isRepo: false, refs: [], previousWorktree: null, defaults: { envMode: "local" } });
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
