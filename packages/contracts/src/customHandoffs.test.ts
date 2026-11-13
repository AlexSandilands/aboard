import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.ts";
import {
  customHandoffLabel,
  customHandoffModel,
  customHandoffThreadTitle,
  customHandoffsFor,
  NO_TASK_BRANCH,
  renderCustomHandoffPrompt,
} from "./customHandoffs.ts";
import { EMPTY_MODEL_TIERS } from "./modelTiers.ts";
import { CustomHandoff, CustomHandoffs, type TaskLink } from "./schemas.ts";

const task = { id: "abc-123", number: 164, title: "Add custom hand-offs" };
const BOARD = "http://127.0.0.1:4317/";

const handoff = (patch: Partial<CustomHandoff> = {}): CustomHandoff => ({
  id: "sandbox",
  name: "Sandbox check",
  prompt: "{{task}}\n\nRun the sandbox.",
  target: "t3-code",
  skipDialog: true,
  model: "inherit",
  workspace: "task_worktree",
  projectIds: null,
  ...patch,
});

const prLink = (headRef: string): TaskLink => ({
  id: "pr-1",
  taskId: task.id,
  label: null,
  syncedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  kind: "pr",
  url: "https://github.com/o/r/pull/1",
  ref: { host: "github.com", repo: "o/r", number: 1 },
  snapshot: {
    state: "open",
    title: "PR",
    checks: "none",
    reviewDecision: null,
    mergeable: "unknown",
    headRef,
    updatedAt: null,
  },
});

describe("CustomHandoffs", () => {
  it("refuses two hand-offs with one id and more than the limit", () => {
    expect(CustomHandoffs.safeParse([handoff(), handoff()]).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => handoff({ id: `h${i}` }));
    expect(CustomHandoffs.safeParse(many).success).toBe(false);
    expect(CustomHandoffs.safeParse(many.slice(0, 20)).success).toBe(true);
  });

  it("takes a blank prompt, which sends the task's reference alone", () => {
    expect(CustomHandoff.safeParse(handoff({ prompt: "" })).success).toBe(true);
  });
});

describe("renderCustomHandoffPrompt", () => {
  it("puts the task's reference where {{task}} is", () => {
    const prompt = renderCustomHandoffPrompt(handoff(), task, BOARD);
    expect(prompt.startsWith('#164 "Add custom hand-offs"\nBoard: http://127.0.0.1:4317/?task=abc-123\n')).toBe(true);
    expect(prompt).toContain(`Call get_task("abc-123") on the ${BRAND.id} MCP server to read it.`);
    expect(prompt).toContain("\n\nRun the sandbox.");
    expect(prompt).not.toContain("{{");
  });

  it("adds the reference on top when the prompt has no {{task}}", () => {
    const prompt = renderCustomHandoffPrompt(
      handoff({ prompt: "Update the docs for {{task.number}} ({{ task.title }}) at {{boardUrl}}." }),
      task,
      BOARD,
    );
    expect(prompt.startsWith('#164 "Add custom hand-offs"\n')).toBe(true);
    expect(prompt).toContain("\n\nUpdate the docs for #164 (Add custom hand-offs) at http://127.0.0.1:4317.");
  });

  it("sends the reference alone for a blank prompt", () => {
    const prompt = renderCustomHandoffPrompt(handoff({ prompt: "  " }), task, BOARD);
    expect(prompt).toMatch(/^#164 "Add custom hand-offs"\nBoard: .*\nCall get_task.*\n\nThis thread is already linked/);
  });

  it("names the task's branch from its links, or says there is none", () => {
    const text = handoff({ prompt: "{{task}} on {{task.branch}}" });
    expect(renderCustomHandoffPrompt(text, task, BOARD)).toContain(`on ${NO_TASK_BRANCH}`);
    const withPr = { ...task, links: [prLink("task/164-custom-handoffs")] };
    expect(renderCustomHandoffPrompt(text, withPr, BOARD)).toContain("on task/164-custom-handoffs");
    // The epic's integration branch is a base, not the task's own work.
    const onEpic = { ...withPr, integrationBranch: "task/164-custom-handoffs" };
    expect(renderCustomHandoffPrompt(text, onEpic, BOARD)).toContain(`on ${NO_TASK_BRANCH}`);
  });

  it("doesn't expand a placeholder that came from the task's title", () => {
    const odd = { ...task, title: "Explain {{boardUrl}}" };
    expect(renderCustomHandoffPrompt(handoff({ prompt: "{{task.title}}" }), odd, BOARD)).toContain(
      "\n\nExplain {{boardUrl}}\n",
    );
  });

  it("says what the board linked: a thread and a session are linked already, Codex links itself", () => {
    expect(renderCustomHandoffPrompt(handoff(), task, BOARD)).toContain("This thread is already linked to the task");
    const claude = renderCustomHandoffPrompt(handoff({ target: "claude-code" }), task, BOARD);
    expect(claude).toContain("already linked it to the task");
    const codex = renderCustomHandoffPrompt(handoff({ target: "codex" }), task, BOARD);
    expect(codex).toContain('label: "Sandbox check on #164"');
    expect(codex).toContain("CODEX_THREAD_ID");
  });
});

describe("what a hand-off's thread and session are called", () => {
  it("puts the hand-off's name before the task's title in a thread's title, and labels a session by it", () => {
    expect(customHandoffThreadTitle(handoff(), task)).toBe("#164 Sandbox check · Add custom hand-offs");
    expect(customHandoffLabel(handoff(), task)).toBe("Sandbox check on #164");
    expect(customHandoffThreadTitle(handoff(), { number: 1, title: "x".repeat(400) })).toHaveLength(300);
  });
});

describe("customHandoffsFor", () => {
  const all = [
    handoff({ id: "t3" }),
    handoff({ id: "claude", target: "claude-code" }),
    handoff({ id: "codex", target: "codex", projectIds: ["p2"] }),
  ];
  const ids = (list: CustomHandoff[]) => list.map((h) => h.id);
  const everything = { t3: true, clis: ["claude-code", "codex", "copilot-cli"] as const };

  it("keeps the hand-offs shown on the task's project, in order", () => {
    expect(ids(customHandoffsFor({ projectId: "p1" }, all, everything))).toEqual(["t3", "claude"]);
    expect(ids(customHandoffsFor({ projectId: "p2" }, all, everything))).toEqual(["t3", "claude", "codex"]);
  });

  it("leaves out a target that can't start here", () => {
    expect(ids(customHandoffsFor({ projectId: "p2" }, all, { t3: false, clis: ["codex"] }))).toEqual(["codex"]);
    expect(customHandoffsFor({ projectId: "p2" }, all, { t3: false, clis: [] })).toEqual([]);
  });

  it("offers none on an epic, a manual task or an archived one", () => {
    expect(customHandoffsFor({ projectId: "p1", kind: "epic" }, all, everything)).toEqual([]);
    expect(customHandoffsFor({ projectId: "p1", manual: true }, all, everything)).toEqual([]);
    expect(customHandoffsFor({ projectId: "p1", archivedAt: "2026-01-01" }, all, everything)).toEqual([]);
    expect(customHandoffsFor({ projectId: "p1" }, undefined, everything)).toEqual([]);
  });
});

describe("customHandoffModel", () => {
  const t3 = { selection: { instanceId: "claude", model: "sonnet", options: [] }, label: "Sonnet" };
  const settings = {
    modelTiers: {
      ...EMPTY_MODEL_TIERS,
      deep: { description: null, t3, cli: { "claude-code": "opus" }, cliEffort: { "claude-code": "high" as const } },
    },
    modelProfiles: [
      { id: "codex61", name: "Codex 6.1", labels: [], description: null, t3: null, cli: { codex: "gpt-6.1" } },
    ],
    operationModels: {},
  };
  const planned = { labels: [], suggestedModel: { tier: "deep" as const, reason: null } };

  it("inherits the task's own model and warns of nothing", () => {
    const model = customHandoffModel(handoff({ target: "claude-code" }), planned, settings);
    expect(model).toMatchObject({ cliModel: "opus", cliEffort: "high", warning: null });
    expect(model.resolved.source).toBe("tier");
    // No tier, nothing chosen: the CLI's own default.
    expect(customHandoffModel(handoff({ target: "claude-code" }), null, settings).cliModel).toBeNull();
  });

  it("uses the hand-off's tier over the task's", () => {
    const light = customHandoffModel(handoff({ target: "claude-code", model: { tier: "light" } }), planned, settings);
    expect(light.cliModel).toBeNull();
    expect(light.warning).toContain("The Light tier has no Claude Code model");
  });

  it("warns when a custom model has nothing for the target", () => {
    const onT3 = customHandoffModel(handoff({ model: { profile: "codex61" } }), planned, settings);
    expect(onT3.warning).toBe(
      "Codex 6.1 has no T3 Code model in Settings → Agents → Models, so the thread starts on T3 Code's default model.",
    );
    const onCodex = customHandoffModel(handoff({ target: "codex", model: { profile: "codex61" } }), planned, settings);
    expect(onCodex).toMatchObject({ cliModel: "gpt-6.1", warning: null });
  });

  it("uses a model typed for the target, and warns about one typed for another provider", () => {
    const typed = { provider: "codex" as const, model: "gpt-5.5", effort: "high" as const };
    const onCodex = customHandoffModel(handoff({ target: "codex", model: typed }), planned, settings);
    expect(onCodex).toMatchObject({ cliModel: "gpt-5.5", cliEffort: "high", warning: null });
    const onClaude = customHandoffModel(handoff({ target: "claude-code", model: typed }), planned, settings);
    expect(onClaude.cliModel).toBeNull();
    expect(onClaude.warning).toContain("is typed for Codex, so Claude Code starts on its default model");
    expect(customHandoffModel(handoff({ model: typed }), planned, settings).warning).toContain("T3 Code's default");
  });

  it("falls back to the task's model when the hand-off's custom model was deleted", () => {
    const gone = customHandoffModel(handoff({ target: "claude-code", model: { profile: "gone" } }), planned, settings);
    expect(gone.cliModel).toBe("opus");
    expect(gone.warning).toContain("no longer exists");
  });
});
