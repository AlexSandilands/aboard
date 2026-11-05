import { describe, expect, it } from "vitest";
import { ModelProfile, type ModelChoice } from "./modelProfiles.ts";
import { EMPTY_MODEL_TIERS, type ModelTiers } from "./modelTiers.ts";
import {
  missingNeeds,
  OperationId,
  OPERATIONS,
  type OperationContext,
  type OperationSettings,
  readOperationModels,
  resolveOperationChoice,
  resolveOperationModel,
  reviewerModelLine,
  t3InstanceHarness,
} from "./operations.ts";
import type { ProviderSetting } from "./providers.ts";

const on = (...ids: ProviderSetting["id"][]): ProviderSetting[] => ids.map((id) => ({ id, enabled: true }));

const tiers: ModelTiers = {
  light: { description: null, t3: null, cli: { "claude-code": "haiku", codex: "gpt-mini" } },
  standard: { description: "Sonnet", t3: null, cli: { "claude-code": "sonnet" }, cliEffort: { "claude-code": "high" } },
  deep: {
    description: null,
    t3: { selection: { instanceId: "codex", model: "gpt-5.5", options: [] }, label: "Codex · GPT-5.5" },
    cli: { "claude-code": "opus" },
    provider: "codex",
  },
};
const codexFirst = ModelProfile.parse({
  id: "codexy",
  name: "Codexy",
  labels: ["codex"],
  description: null,
  t3: null,
  cli: { codex: "gpt-5.5-codex", "claude-code": "sonnet" },
  cliEffort: { codex: "xhigh" },
  provider: "codex",
});

const settings = (over: Partial<OperationSettings> = {}): OperationSettings => ({
  modelTiers: tiers,
  modelProfiles: [codexFirst],
  operationModels: {},
  providers: on("claude-code", "codex"),
  ...over,
});

const task = (tier: "light" | "standard" | "deep" | null, labels: string[] = []) => ({
  labels,
  suggestedModel: tier ? { tier, reason: null } : null,
});

describe("the operation registry", () => {
  it("lists every operation, with a provider-neutral default", () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual([...OperationId.options].sort());
    for (const info of Object.values(OPERATIONS)) {
      const d: ModelChoice = info.default;
      expect(d === "inherit" || "tier" in d).toBe(true);
    }
    expect(OPERATIONS.ask.default).toEqual({ tier: "light" });
    expect(OPERATIONS.orchestrate.default).toEqual({ tier: "standard" });
    expect(OPERATIONS.taskRun.default).toBe("inherit");
  });

  it("only lets Claude Code meet the needs the other CLIs can't", () => {
    expect(missingNeeds("claude-code", ["outputSchema", "untrusted", "noTools", "toolRules", "edit"])).toEqual([]);
    expect(missingNeeds("codex", ["edit"])).toEqual([]);
    expect(missingNeeds("copilot-cli", ["outputSchema", "edit", "noTools"])).toEqual(["outputSchema", "noTools"]);
  });

  it("reads stored operation models one by one, dropping what doesn't parse", () => {
    expect(
      readOperationModels({
        ask: { tier: "deep" },
        nope: { tier: "deep" },
        digest: { model: "haiku" },
        launch: "inherit",
      }),
    ).toEqual({ ask: { tier: "deep" }, launch: "inherit" });
    expect(readOperationModels(null)).toEqual({});
  });

  it("maps T3 Code's instance ids to the CLI that files the same models", () => {
    expect(t3InstanceHarness("claudeAgent")).toBe("claude-code");
    expect(t3InstanceHarness("codex")).toBe("codex");
    expect(t3InstanceHarness("opencode")).toBeNull();
  });
});

describe("resolveOperationChoice: precedence", () => {
  const cases: Array<{
    name: string;
    op: OperationId;
    ctx: OperationContext;
    board?: Partial<Record<OperationId, ModelChoice>>;
    want: { source: string; id?: string; explicit?: string };
  }> = [
    { name: "the default when nothing is set", op: "ask", ctx: {}, want: { source: "default", id: "light" } },
    {
      name: "the board over the default",
      op: "ask",
      ctx: {},
      board: { ask: { tier: "deep" } },
      want: { source: "board", id: "deep" },
    },
    {
      name: "the automation over the board",
      op: "orchestrate",
      ctx: { automation: [{ tier: "light" }] },
      board: { orchestrate: { tier: "deep" } },
      want: { source: "automation", id: "light" },
    },
    {
      name: "the automation's config over its action's own choice",
      op: "customTask",
      ctx: { automation: [{ tier: "deep" }, { tier: "light" }], task: task("standard") },
      want: { source: "automation", id: "deep" },
    },
    {
      name: "an inherit config passes to the action's own choice",
      op: "customTask",
      ctx: { automation: ["inherit", { tier: "light" }], task: task("standard") },
      want: { source: "automation", id: "light" },
    },
    {
      name: "the task's override over the project's and the board's",
      op: "boardReviewer",
      ctx: { taskOverride: { tier: "light" }, projectOverride: { tier: "deep" } },
      board: { boardReviewer: { tier: "deep" } },
      want: { source: "task", id: "light" },
    },
    {
      name: "the project's override when the task inherits",
      op: "reviewer",
      ctx: { taskOverride: null, projectOverride: { provider: "codex", model: "gpt-5.5" } },
      want: { source: "project", explicit: "gpt-5.5" },
    },
    {
      name: "reviewer overrides only for the reviewers",
      op: "taskRun",
      ctx: { taskOverride: { tier: "light" }, task: task("deep") },
      want: { source: "tier", id: "deep" },
    },
    {
      name: "a task-scoped inherit takes a label's custom model over the task's tier",
      op: "taskRun",
      ctx: { task: task("deep", ["Codex"]) },
      want: { source: "label", id: "codexy" },
    },
    {
      name: "a task-scoped inherit with no tier falls back to light",
      op: "prFix",
      ctx: { task: task(null) },
      want: { source: "fallback", id: "light" },
    },
    {
      name: "a board setting of inherit defers to the operation's default",
      op: "digest",
      ctx: { task: task("deep") },
      board: { digest: "inherit" },
      want: { source: "default", id: "light" },
    },
    {
      name: "an operation without a task never takes a task's model",
      op: "customDetached",
      ctx: { task: task("deep", ["codex"]), automation: ["inherit"] },
      board: { customDetached: { tier: "standard" } },
      want: { source: "board", id: "standard" },
    },
  ];
  it.each(cases)("$name", ({ op, ctx, board, want }) => {
    const choice = resolveOperationChoice(op, ctx, settings({ operationModels: board ?? {} }));
    expect({ source: choice.source, id: choice.profile?.id, explicit: choice.explicit?.model }).toEqual({
      source: want.source,
      id: want.id,
      explicit: want.explicit,
    });
  });

  it("passes over a deleted custom model with a note, to the next setting", () => {
    const choice = resolveOperationChoice(
      "taskRun",
      { automation: [{ profile: "gone" }], task: task("standard") },
      settings({ operationModels: { taskRun: { profile: "gone-too" } } }),
    );
    expect(choice).toMatchObject({ source: "tier", profile: { id: "standard" } });
    expect(choice.note).toContain('"gone" set for Task runs no longer exists');
    expect(choice.note).toContain('"gone-too"');
  });
});

describe("resolveOperationModel: picking a provider", () => {
  it("runs a tier on its preferred provider when it is added, on and capable", () => {
    const r = resolveOperationModel("taskRun", { task: task("deep") }, settings());
    expect(r).toMatchObject({ ok: true, provider: "codex", model: "gpt-5.5", effort: null, source: "tier" });
    // The T3 model stood in for the Codex CLI model the tier doesn't set: no effort goes with it.
  });

  it("carries a custom model's effort with its CLI model", () => {
    const r = resolveOperationModel("taskRun", { task: task(null, ["codex"]) }, settings());
    expect(r).toMatchObject({ ok: true, provider: "codex", model: "gpt-5.5-codex", effort: "xhigh", source: "label" });
  });

  it("falls back, with a note, when the preferred provider isn't on", () => {
    const off = settings({
      providers: [
        { id: "codex", enabled: false },
        { id: "claude-code", enabled: true },
      ],
    });
    const r = resolveOperationModel("taskRun", { task: task("deep") }, off);
    expect(r).toMatchObject({ ok: true, provider: "claude-code", model: "opus" });
    expect(r).toMatchObject({ note: expect.stringContaining("prefers Codex, which isn't added and switched on") });
  });

  it("falls back, with a note, when the preferred provider can't do what the operation needs", () => {
    const r = resolveOperationModel("prReview", { automation: [{ tier: "deep" }] }, settings());
    expect(r).toMatchObject({ ok: true, provider: "claude-code", model: "opus" });
    expect(r).toMatchObject({ note: expect.stringContaining("prefers Codex, which can't return structured output") });
  });

  it("takes the first provider in the user's order that has a model for the tier", () => {
    const light = { ...tiers, light: { description: null, t3: null, cli: { codex: "gpt-mini" } } };
    const r = resolveOperationModel(
      "customDetached",
      {},
      settings({ modelTiers: light, providers: on("copilot-cli", "codex", "claude-code") }),
    );
    expect(r).toMatchObject({ ok: true, provider: "codex", model: "gpt-mini" });
  });

  it("runs the first capable provider's default model when no provider has one, and says so", () => {
    const r = resolveOperationModel(
      "digest",
      {},
      settings({ modelTiers: { ...EMPTY_MODEL_TIERS, light: { description: null, t3: null, cli: { codex: "x" } } } }),
    );
    expect(r).toMatchObject({ ok: true, provider: "claude-code", model: null, effort: null });
    expect(r).toMatchObject({ note: expect.stringContaining("has no Claude Code model") });
    // An empty tier is the CLI's default as always, with nothing to say.
    const empty = resolveOperationModel("digest", {}, settings({ modelTiers: EMPTY_MODEL_TIERS }));
    expect(empty).toMatchObject({ ok: true, provider: "claude-code", model: null, note: null });
  });

  it("skips disabled, missing and incapable providers", () => {
    const r = resolveOperationModel(
      "ask",
      {},
      settings({
        providers: [
          { id: "codex", enabled: true },
          { id: "t3-code", enabled: true },
          { id: "claude-code", enabled: true },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: true, provider: "claude-code", model: "haiku" });
  });

  it("asks a run's extra needs of the provider too", () => {
    const codexOnly = settings({ providers: on("codex") });
    expect(resolveOperationModel("customTask", { task: task("light") }, codexOnly)).toMatchObject({
      ok: true,
      provider: "codex",
    });
    const r = resolveOperationModel("customTask", { task: task("light"), needs: ["toolRules"] }, codexOnly);
    expect(r).toEqual({
      ok: false,
      reason:
        "Custom automations on a task needs a provider that can follow tool rules of its own; add one in Settings → Providers.",
    });
  });

  it("refuses, with the reason, when no provider can run it", () => {
    expect(resolveOperationModel("ask", {}, settings({ providers: on("codex", "copilot-cli") }))).toEqual({
      ok: false,
      reason:
        "Ask needs a provider that can return structured output and run with no tools; add one in Settings → Providers.",
    });
    expect(resolveOperationModel("launch", {}, settings({ providers: [] }))).toEqual({
      ok: false,
      reason: "New sessions needs a provider; add one in Settings → Providers.",
    });
  });

  it("runs a typed model on its own provider only, with an effort that provider takes", () => {
    const typed = (choice: ModelChoice) => settings({ operationModels: { orchestrate: choice } });
    expect(
      resolveOperationModel("orchestrate", {}, typed({ provider: "claude-code", model: "opus", effort: "max" })),
    ).toMatchObject({ ok: true, provider: "claude-code", model: "opus", effort: "max", source: "board" });
    expect(
      resolveOperationModel("taskRun", { automation: [{ provider: "codex", model: "x", effort: "max" }] }, settings()),
    ).toMatchObject({ ok: true, provider: "codex", model: "x", effort: null });
    expect(resolveOperationModel("orchestrate", {}, typed({ provider: "codex", model: "gpt-5.5" }))).toEqual({
      ok: false,
      reason:
        "Orchestrate is set to run on Codex, which can't lock a run down to read untrusted input and follow tool rules of its own.",
    });
    expect(resolveOperationModel("orchestrate", {}, typed({ provider: "copilot-cli", model: "gpt-5.5" }))).toEqual({
      ok: false,
      reason:
        "Orchestrate is set to run gpt-5.5 on Copilot CLI, which isn't added and switched on in Settings → Providers.",
    });
  });
});

describe("the reviewer subagent's line", () => {
  it("says nothing while the reviewer inherits the task's model", () => {
    expect(reviewerModelLine({ task: task("deep") }, settings())).toBeNull();
  });

  it("names the model above the task's, with the Claude Code way to pick it", () => {
    expect(
      reviewerModelLine({ task: task("deep") }, settings({ operationModels: { reviewer: { tier: "standard" } } })),
    ).toBe(
      'Run the reviewer on the standard tier (Sonnet): in Claude Code pass `model: "sonnet"` to the Agent tool; elsewhere pick that model if your harness lets you, else use your own.',
    );
    expect(reviewerModelLine({ taskOverride: { provider: "codex", model: "gpt-5.5" } }, settings())).toBe(
      "Run the reviewer on `gpt-5.5` (Codex): pick that model if your harness lets you, else use your own.",
    );
  });
});
