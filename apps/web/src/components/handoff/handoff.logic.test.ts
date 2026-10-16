import { clampRuntimeMode, runtimeModesFor, type T3LaunchOptions, type T3LaunchProvider } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  canStartProjectT3Thread,
  canStartT3Thread,
  FAVORITES,
  initialPickerTab,
  initialWorkspaceChoice,
  keepsCommandId,
  launchModelSelection,
  modelTraits,
  optionValue,
  pickerModels,
  refBadge,
  refDisabledReason,
  refLabel,
  selectionAfterPlanToggle,
  selectionLabel,
  selectModel,
  setOption,
  showHandoffActions,
  toLaunchWorkspace,
  workspaceLabel,
} from "./handoff.logic";

const effort = {
  type: "select" as const,
  id: "effort",
  label: "Effort",
  options: [
    { id: "low", label: "Low", isDefault: false },
    { id: "medium", label: "Medium", isDefault: true },
  ],
  currentValue: null,
};
const fastMode = { type: "boolean" as const, id: "fastMode", label: "Fast mode", currentValue: false };

const claude: T3LaunchProvider = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  ready: true,
  message: null,
  supportedRuntimeModes: [],
  models: [
    { slug: "opus", name: "Claude Opus", badge: null, isLegacy: false, isDefault: true, options: [effort, fastMode] },
    { slug: "haiku", name: "Claude Haiku", badge: "new", isLegacy: false, isDefault: false, options: [] },
    { slug: "old", name: "Claude Old", badge: null, isLegacy: true, isDefault: false, options: [effort] },
  ],
};
const codex: T3LaunchProvider = {
  ...claude,
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  supportedRuntimeModes: ["approval-required", "auto"],
  models: [{ slug: "gpt", name: "GPT", badge: null, isLegacy: false, isDefault: true, options: [] }],
};

const ROOT = "C:\\Code\\acme";
const options: T3LaunchOptions = {
  t3ProjectId: "t3-p1",
  workspaceRoot: ROOT,
  providers: [claude, codex],
  favorites: [{ instanceId: "codex", model: "gpt" }],
  isRepo: true,
  refs: [
    { name: "main", isRemote: false, current: true, isDefault: true, worktreePath: "C:/Code/acme/" },
    { name: "feature", isRemote: false, current: false, isDefault: false, worktreePath: null },
    { name: "t3/wt", isRemote: false, current: false, isDefault: false, worktreePath: "C:/wt/one" },
    { name: "origin/main", isRemote: true, current: false, isDefault: false, worktreePath: null },
  ],
  previousWorktree: { worktreePath: "C:/wt/prev", branch: "t3/prev" },
  suggestion: null,
  defaults: {
    modelSelection: { instanceId: "claudeAgent", model: "opus", options: [] },
    runtimeMode: "full-access",
    envMode: "local",
    startFromOrigin: true,
  },
};

describe("suggested model", () => {
  const sonnet = { instanceId: "claudeAgent", model: "sonnet", options: [{ id: "effort", value: "low" }] };
  const suggested: T3LaunchOptions = {
    ...options,
    suggestion: { tier: "light", reason: null, modelSelection: sonnet, unavailable: null },
  };

  it("starts work on the suggested model and planning on T3's default", () => {
    expect(launchModelSelection(suggested, false)).toEqual(sonnet);
    expect(launchModelSelection(suggested, true)?.model).toBe("opus");
    expect(launchModelSelection(options, false)?.model).toBe("opus");
    const unresolved = { ...options, suggestion: { ...suggested.suggestion!, modelSelection: null, unavailable: "x" } };
    expect(launchModelSelection(unresolved, false)?.model).toBe("opus");
  });

  it("swaps models when the mode toggles, keeping a model picked by hand", () => {
    expect(selectionAfterPlanToggle(suggested, sonnet, true)?.model).toBe("opus");
    expect(selectionAfterPlanToggle(suggested, options.defaults.modelSelection, false)).toEqual(sonnet);
    const picked = { instanceId: "codex", model: "gpt", options: [] };
    expect(selectionAfterPlanToggle(suggested, picked, true)).toEqual(picked);
  });
});

it("selectionLabel names the model and the options set explicitly", () => {
  expect(selectionLabel(options, { instanceId: "codex", model: "gpt", options: [] })).toBe("GPT");
  expect(selectionLabel(options, { instanceId: "codex", model: "gone", options: [] })).toBe("gone");
  const opus = {
    instanceId: "claudeAgent",
    model: "opus",
    options: [
      { id: "effort", value: "low" },
      { id: "fastMode", value: true },
    ],
  };
  expect(selectionLabel(options, opus)).toBe("Claude Opus, Low, fast");
});

describe("visibility", () => {
  const task = { status: "backlog" as const, archivedAt: null };
  const project = { t3ProjectId: null, workspaceRoot: ROOT };
  const t3 = { detected: true };
  const settings = { t3TokenSet: true };

  it("hides hand-off actions on finished or archived tasks", () => {
    expect(showHandoffActions(task)).toBe(true);
    expect(showHandoffActions({ ...task, status: "done" })).toBe(false);
    expect(showHandoffActions({ ...task, archivedAt: "x" })).toBe(false);
  });

  it("offers hand-off on open epics too, whose prompt starts their tasks", () => {
    const epic = { ...task, kind: "epic" as const };
    expect(showHandoffActions(epic)).toBe(true);
    expect(showHandoffActions({ ...epic, status: "done" })).toBe(false);
  });

  it("offers a new T3 Code thread whenever T3 can take it, even with threads linked", () => {
    expect(canStartT3Thread(task, project, t3, settings)).toBe(true);
    expect(canStartT3Thread(task, project, { detected: false }, settings)).toBe(false);
    expect(canStartT3Thread(task, project, t3, { t3TokenSet: false })).toBe(false);
    expect(canStartT3Thread(task, { t3ProjectId: null, workspaceRoot: null }, t3, settings)).toBe(false);
    expect(canStartT3Thread(task, { t3ProjectId: "t3-p1", workspaceRoot: null }, t3, settings)).toBe(true);
  });

  it("offers Suggest epics in T3 Code for a project on the same conditions, with no task involved", () => {
    expect(canStartProjectT3Thread(project, t3, settings)).toBe(true);
    expect(canStartProjectT3Thread(project, { detected: false }, settings)).toBe(false);
    expect(canStartProjectT3Thread({ t3ProjectId: null, workspaceRoot: null }, t3, settings)).toBe(false);
  });
});

describe("model picker", () => {
  it("lists favorites, a provider's models with legacy split out, or search results across providers", () => {
    expect(initialPickerTab(options, null)).toBe(FAVORITES);
    expect(initialPickerTab({ ...options, favorites: [] }, options.defaults.modelSelection)).toBe("claudeAgent");
    expect(pickerModels(options, FAVORITES, "").models.map((e) => e.model.slug)).toEqual(["gpt"]);
    const tab = pickerModels(options, "claudeAgent", "");
    expect(tab.models.map((e) => e.model.slug)).toEqual(["opus", "haiku"]);
    expect(tab.legacy.map((e) => e.model.slug)).toEqual(["old"]);
    expect(pickerModels(options, FAVORITES, "codex").models.map((e) => e.model.slug)).toEqual(["gpt"]);
    expect(pickerModels(options, "codex", "OLD").models.map((e) => e.model.slug)).toEqual(["old"]);
  });

  it("keeps compatible option values when switching models and defaults the rest", () => {
    const start = setOption(setOption(options.defaults.modelSelection!, "effort", "low"), "fastMode", true);
    expect(optionValue(start, effort)).toBe("low");
    const old = selectModel(start, { provider: claude, model: claude.models[2]! });
    expect(old).toEqual({ instanceId: "claudeAgent", model: "old", options: [{ id: "effort", value: "low" }] });
    const haiku = selectModel(start, { provider: claude, model: claude.models[1]! });
    expect(haiku.options).toEqual([]);
    expect(optionValue({ ...haiku, model: "opus" }, effort)).toBe("medium");
  });

  it("finds the effort select and fast mode toggle", () => {
    expect(modelTraits(claude.models[0])).toEqual({ effort, fastMode });
    expect(modelTraits(claude.models[1])).toEqual({ effort: null, fastMode: null });
  });
});

it("reuses a launch's commandId unless T3 definitely rejected it", () => {
  expect(keepsCommandId({ t3: "unreachable" })).toBe(true);
  expect(keepsCommandId({ t3: "protocol-after-send" })).toBe(true);
  expect(keepsCommandId(undefined)).toBe(true);
  expect(keepsCommandId(null)).toBe(true);
  expect(keepsCommandId({ t3: "failed" })).toBe(false);
  expect(keepsCommandId({ t3: "forbidden" })).toBe(false);
  expect(keepsCommandId({})).toBe(false);
});

describe("access", () => {
  it("filters runtime modes by provider support and clamps to the most permissive one", () => {
    expect(runtimeModesFor(claude)).toHaveLength(4);
    expect(runtimeModesFor(codex).map((m) => m.label)).toEqual(["Supervised", "Auto"]);
    expect(clampRuntimeMode("full-access", codex)).toBe("auto");
    expect(clampRuntimeMode("approval-required", codex)).toBe("approval-required");
  });
});

describe("workspace", () => {
  it("starts in the configured mode", () => {
    expect(initialWorkspaceChoice(options)).toEqual({ mode: "current", ref: null });
    const worktree = { ...options, defaults: { ...options.defaults, envMode: "worktree" as const } };
    expect(initialWorkspaceChoice(worktree)).toEqual({ mode: "new_worktree", ref: null });
    expect(initialWorkspaceChoice({ ...worktree, isRepo: false }).mode).toBe("current");
  });

  it("badges refs like T3", () => {
    expect(options.refs.map((r) => refBadge(r, ROOT))).toEqual(["current", null, "worktree", "remote"]);
  });

  it("never switches the current checkout's branch", () => {
    expect(refDisabledReason(options.refs[1]!, "current", ROOT)).toMatch(/New worktree/);
    expect(refDisabledReason(options.refs[1]!, "new_worktree", ROOT)).toBeNull();
    expect(refDisabledReason(options.refs[2]!, "current", ROOT)).toBeNull();
    expect(toLaunchWorkspace(options, { mode: "current", ref: "feature" })).toBeNull();
  });

  it("maps choices to the launch workspace", () => {
    expect(toLaunchWorkspace(options, { mode: "current", ref: null })).toEqual({ mode: "current" });
    expect(toLaunchWorkspace(options, { mode: "current", ref: "t3/wt" })).toEqual({
      mode: "existing_worktree",
      worktreePath: "C:/wt/one",
      branch: "t3/wt",
    });
    expect(toLaunchWorkspace(options, { mode: "new_worktree", ref: null })).toEqual({
      mode: "new_worktree",
      baseRef: "main",
      startFromOrigin: true,
    });
    expect(toLaunchWorkspace(options, { mode: "new_worktree", ref: "origin/main" })).toEqual({
      mode: "new_worktree",
      baseRef: "origin/main",
      startFromOrigin: false,
    });
    expect(toLaunchWorkspace(options, { mode: "previous", ref: null })).toEqual({
      mode: "existing_worktree",
      worktreePath: "C:/wt/prev",
      branch: "t3/prev",
    });
  });

  it("labels the triggers", () => {
    expect(workspaceLabel(options, { mode: "current", ref: null })).toBe("Current checkout");
    expect(workspaceLabel(options, { mode: "current", ref: "t3/wt" })).toBe("Current worktree");
    expect(refLabel(options, { mode: "current", ref: null })).toBe("main");
    expect(refLabel(options, { mode: "new_worktree", ref: null })).toBe("From origin/main");
    expect(refLabel(options, { mode: "new_worktree", ref: "origin/main" })).toBe("From origin/main");
    expect(refLabel(options, { mode: "previous", ref: null })).toBe("t3/prev");
  });
});
