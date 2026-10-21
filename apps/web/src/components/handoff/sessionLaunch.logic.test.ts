import type { SessionLaunchOptions } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  emptySessionPickState,
  initialModel,
  initialWhere,
  modelError,
  pickSessionBy,
  picksAfterPlanToggle,
  startedDescription,
  syncSessionPicks,
  toSessionWorkspace,
} from "./sessionLaunch.logic";

const options = { models: { "claude-code": "opus", codex: null, "copilot-cli": null } };

describe("new session dialog", () => {
  it("starts in a new worktree from the default branch, or in the checkout when it isn't a repository", () => {
    expect(initialWhere({ isRepo: true, defaultBaseRef: "main" })).toEqual({ mode: "new_worktree", baseRef: "main" });
    expect(initialWhere({ isRepo: false, defaultBaseRef: null })).toEqual({ mode: "current" });
  });

  it("starts a task of an integration epic from its epic's branch, origin's copy first", () => {
    const repo = { isRepo: true, defaultBaseRef: "main", branches: ["main", "epic/x", "origin/epic/x"] };
    expect(initialWhere(repo, "epic/x")).toEqual({ mode: "new_worktree", baseRef: "origin/epic/x" });
    expect(initialWhere({ ...repo, branches: ["main", "epic/x"] }, "epic/x")).toEqual({
      mode: "new_worktree",
      baseRef: "epic/x",
    });
    // A branch that isn't there yet falls back to the default.
    expect(initialWhere(repo, "epic/gone")).toEqual({ mode: "new_worktree", baseRef: "main" });
  });

  it("needs a branch before a worktree can be made", () => {
    expect(toSessionWorkspace({ mode: "new_worktree", baseRef: null })).toBeNull();
    expect(toSessionWorkspace({ mode: "new_worktree", baseRef: "origin/x" })).toEqual({
      mode: "new_worktree",
      baseRef: "origin/x",
    });
    expect(toSessionWorkspace({ mode: "current" })).toEqual({ mode: "current" });
  });

  it("uses the tier's model for this CLI when working, and the CLI's default when planning or unset", () => {
    expect(initialModel(options, "claude-code", false)).toBe("opus");
    expect(initialModel(options, "claude-code", true)).toBe("");
    expect(initialModel(options, "copilot-cli", false)).toBe("");
  });

  it("accepts a blank model or a model name, nothing a shell would read", () => {
    expect(modelError("")).toBeNull();
    expect(modelError("claude-opus-5-5[1m]")).toBeNull();
    expect(modelError("opus && calc")).toMatch(/only letters/);
  });

  it("says where the session runs and where the full prompt went", () => {
    expect(startedDescription({ branch: null, shortPrompt: null }, [3], false)).toBe(
      "#3 is linked to the new session.",
    );
    expect(startedDescription({ branch: "aboard/3-abc", shortPrompt: "Let's work on #3" }, [3], true)).toBe(
      "#3 is linked to the new session. It runs in a new worktree on aboard/3-abc. The full prompt is on your clipboard: paste it into the session.",
    );
    // The clipboard refused it: the toast's Copy prompt button is the way to it.
    expect(startedDescription({ branch: null, shortPrompt: "Let's work on #3" }, [3], false)).toBe(
      "#3 is linked to the new session. Copy the full prompt and paste it into the session.",
    );
    expect(startedDescription({ branch: null, shortPrompt: null }, [3, 4, 7], false)).toBe(
      "#3, #4 and #7 are linked to the new session.",
    );
  });
});

const launchOptions = (model: string | null): SessionLaunchOptions => ({
  clis: [],
  workspaceRoot: "/repo",
  isRepo: true,
  branches: ["main", "origin/main"],
  defaultBaseRef: "origin/main",
  models: { "claude-code": model, codex: null, "copilot-cli": null },
  efforts: { "claude-code": model ? "high" : null, codex: null, "copilot-cli": null },
  tier: "standard",
  model: null,
  namedWindow: false,
});

describe("the session dialog's choices", () => {
  it("waits for the options, then makes the choices from them", () => {
    expect(syncSessionPicks(emptySessionPickState, undefined, "claude-code", false, null)).toBe(emptySessionPickState);
    const loaded = launchOptions("opus");
    expect(syncSessionPicks(emptySessionPickState, loaded, "claude-code", false, null).picks).toEqual({
      model: "opus",
      effort: "high",
      where: { mode: "new_worktree", baseRef: "origin/main" },
    });
  });

  it("follows a refresh until the user picks, then never moves", () => {
    const seeded = syncSessionPicks(emptySessionPickState, launchOptions("opus"), "claude-code", false, null);
    expect(syncSessionPicks(seeded, seeded.seededFrom, "claude-code", false, null)).toBe(seeded);
    const refreshed = syncSessionPicks(seeded, launchOptions("sonnet"), "claude-code", false, null);
    expect(refreshed.picks?.model).toBe("sonnet");
    const picked = pickSessionBy(refreshed, (picks) => ({ ...picks, model: "haiku" }));
    expect(syncSessionPicks(picked, launchOptions("opus"), "claude-code", false, null)).toBe(picked);
    expect(picked.picks?.model).toBe("haiku");
  });

  it("ignores a pick before there are choices", () => {
    expect(pickSessionBy(emptySessionPickState, (picks) => ({ ...picks, model: "x" }))).toBe(emptySessionPickState);
  });

  it("swaps the model and effort with Plan with me only while they are the dialog's own", () => {
    const loaded = launchOptions("opus");
    const working = { model: "opus", effort: "high" as const, where: { mode: "current" as const } };
    expect(picksAfterPlanToggle(working, loaded, "claude-code", false)).toEqual({
      ...working,
      model: "",
      effort: null,
    });
    const planning = { ...working, model: "", effort: null };
    expect(picksAfterPlanToggle(planning, loaded, "claude-code", true)).toEqual(working);
    // A model the user chose stays.
    const chosen = { ...working, model: "haiku" };
    expect(picksAfterPlanToggle(chosen, loaded, "claude-code", false)).toBe(chosen);
  });
});
