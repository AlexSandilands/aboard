import type { StartCustomHandoffResult } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  handoffWhere,
  startedHandoffNotes,
  startedHandoffTitle,
  startedThreadDescription,
} from "./customHandoffs.logic";

const result = (patch: Partial<StartCustomHandoffResult> = {}): StartCustomHandoffResult => ({
  name: "Sandbox check",
  target: "t3-code",
  prompt: "Go",
  link: null,
  session: null,
  workspace: "task_worktree",
  branch: "task/164-custom-handoffs",
  fellBack: false,
  model: "claude-sonnet-5-5",
  note: null,
  ...patch,
});

describe("the toast for a hand-off started without its dialog", () => {
  it("says what started, on which model, where, and that it is linked", () => {
    expect(startedHandoffTitle(result())).toBe("Started “Sandbox check”");
    expect(startedThreadDescription(result(), 164)).toBe(
      "T3 Code thread on claude-sonnet-5-5 in the task's worktree on task/164-custom-handoffs. Linked to #164.",
    );
  });

  it("says a new worktree was made when the task had none", () => {
    const fallback = result({ workspace: "new_worktree", branch: "main", fellBack: true });
    expect(startedHandoffTitle(fallback)).toBe("Started “Sandbox check” in a new worktree");
    expect(startedThreadDescription(fallback, 164)).toBe(
      "T3 Code thread on claude-sonnet-5-5 in a new worktree from main. Linked to #164. #164 had no worktree yet, so one was made.",
    );
  });

  it("adds why the hand-off's model wasn't used", () => {
    const note = "Codex 6.1 has no T3 Code model.";
    expect(startedHandoffNotes(result({ note }), 164)).toEqual([note]);
    expect(startedThreadDescription(result({ note, model: null, workspace: "current", branch: null }), 164)).toBe(
      `T3 Code thread in the project's checkout. Linked to #164. ${note}`,
    );
  });

  it("names a CLI session's new branch as the one it runs on", () => {
    const cli = result({ target: "claude-code", workspace: "new_worktree", branch: "aboard/164-ab12cd34" });
    expect(handoffWhere(cli)).toBe("in a new worktree on aboard/164-ab12cd34");
    expect(handoffWhere(result({ workspace: "new_worktree", branch: null }))).toBe("in a new worktree");
  });
});
