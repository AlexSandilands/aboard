import type { T3LaunchOptions } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { initialWorkspaceChoice } from "./handoff.logic";

const ref = (name: string, isRemote = false) => ({
  name,
  isRemote,
  current: false,
  isDefault: false,
  worktreePath: null,
});
const options = {
  isRepo: true,
  defaults: { envMode: "local" },
  refs: [ref("main"), ref("epic/4-checkout"), ref("origin/epic/4-checkout", true)],
} as unknown as Pick<T3LaunchOptions, "isRepo" | "defaults" | "refs">;

describe("the launch dialog for a task of an integration epic", () => {
  it("opens on a new worktree from origin's copy of the epic's branch", () => {
    expect(initialWorkspaceChoice(options, "epic/4-checkout")).toEqual({
      mode: "new_worktree",
      ref: "origin/epic/4-checkout",
    });
    const localOnly = { ...options, refs: [ref("epic/4-checkout")] };
    expect(initialWorkspaceChoice(localOnly, "epic/4-checkout")).toEqual({
      mode: "new_worktree",
      ref: "epic/4-checkout",
    });
  });

  it("follows T3's settings when the branch isn't listed, or the task has none", () => {
    expect(initialWorkspaceChoice(options, "epic/9-other")).toEqual({ mode: "current", ref: null });
    expect(initialWorkspaceChoice(options)).toEqual({ mode: "current", ref: null });
  });
});
