import { describe, expect, it } from "vitest";
import { initialModel, initialWhere, modelError, startedDescription, toSessionWorkspace } from "./sessionLaunch.logic";

const options = { models: { "claude-code": "opus", "copilot-cli": null } };

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
    expect(startedDescription({ branch: null, shortPrompt: null }, 3, false)).toBe("#3 is linked to the new session.");
    expect(startedDescription({ branch: "aboard/3-abc", shortPrompt: "Let's work on #3" }, 3, true)).toBe(
      "#3 is linked to the new session. It runs in a new worktree on aboard/3-abc. The full prompt is on your clipboard: paste it into the session.",
    );
    // The clipboard refused it: the toast's Copy prompt button is the way to it.
    expect(startedDescription({ branch: null, shortPrompt: "Let's work on #3" }, 3, false)).toBe(
      "#3 is linked to the new session. Copy the full prompt and paste it into the session.",
    );
  });
});
