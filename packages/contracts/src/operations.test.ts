import { describe, expect, it } from "vitest";
import { ModelProfile, type ModelChoice } from "./modelProfiles.ts";
import { EMPTY_MODEL_TIERS, type ModelTiers } from "./modelTiers.ts";
import {
  checkNeeds,
  IMPORT_TICKET_NEEDS,
  missingNeeds,
  needsWarning,
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

  it("lets Codex return structured output and run isolated read-only, and warns rather than lock it down", () => {
    expect(checkNeeds("codex", ["outputSchema", "readOnly"])).toEqual({ missing: [], warned: [] });
    expect(checkNeeds("codex", ["outputSchema", "untrusted", "runTools"])).toEqual({
      missing: [],
      warned: ["untrusted"],
    });
    expect(checkNeeds("codex", ["untrusted", "noTools"])).toEqual({ missing: ["noTools"], warned: ["untrusted"] });
    // Without the isolated read-only run there is nothing to warn about: it can't run it at all.
    expect(checkNeeds("copilot-cli", ["untrusted"])).toEqual({ missing: ["untrusted"], warned: [] });
    expect(checkNeeds("claude-code", ["untrusted", "readOnly", "noTools"])).toEqual({ missing: [], warned: [] });
    expect(needsWarning("codex", ["untrusted"])).toMatch(/^Codex can't confine its file reads/);
    expect(needsWarning("codex", ["readOnly"])).toBeNull();
    expect(needsWarning("claude-code", ["untrusted"])).toBeNull();
  });

  it("lets Claude Code and Codex use the board's run tools, and not yet the Copilot CLI", () => {
    expect(missingNeeds("claude-code", ["runTools"])).toEqual([]);
    expect(missingNeeds("codex", ["runTools"])).toEqual([]);
    expect(missingNeeds("copilot-cli", ["runTools"])).toEqual(["runTools"]);
    // A PR review reads through them instead of following tool rules of its own.
    expect(OPERATIONS.prReview.needs).toEqual(["outputSchema", "untrusted", "runTools"]);
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
      name: "a board setting of inherit on an operation on a task skips its default for the task's model",
      op: "prReview",
      ctx: { task: task("deep") },
      board: { prReview: "inherit" },
      want: { source: "tier", id: "deep" },
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
    const r = resolveOperationModel("orchestrate", { automation: [{ tier: "deep" }] }, settings());
    expect(r).toMatchObject({ ok: true, provider: "claude-code", model: "opus", warning: null });
    expect(r).toMatchObject({
      note: expect.stringContaining("prefers Codex, which can't follow tool rules of its own"),
    });
  });

  it("runs a chosen tier on its preferred provider with a warning when that provider only partly locks down", () => {
    const r = resolveOperationModel("prReview", { automation: [{ tier: "deep" }] }, settings());
    expect(r).toMatchObject({ ok: true, provider: "codex", model: "gpt-5.5" });
    const warning =
      "Codex can't confine its file reads, so text anyone can write (a pull request, an issue) could make it leak local files into what it returns.";
    expect(r).toMatchObject({ warning, note: warning });
  });

  it("never falls back to a provider that carries a warning", () => {
    // The standard tier prefers nothing, so Codex would only be a fallback.
    const r = resolveOperationModel("prReview", {}, settings({ providers: on("codex", "claude-code") }));
    expect(r).toMatchObject({ ok: true, provider: "claude-code", warning: null });
    expect(resolveOperationModel("prReview", {}, settings({ providers: on("codex") }))).toEqual({
      ok: false,
      reason:
        "PR review needs a provider that can return structured output, lock a run down to read untrusted input and use the board's run tools; add one in Settings → Providers. Codex can run it with a warning if you choose it for PR review on the Models page.",
    });
    // A tier that is only the operation's default (or the task's own model) was chosen for other work: its preferred
    // provider doesn't get untrusted text, and the note says why.
    const standardCodex = settings({ modelTiers: { ...tiers, standard: { ...tiers.standard, provider: "codex" } } });
    const byDefault = resolveOperationModel("prReview", {}, standardCodex);
    expect(byDefault).toMatchObject({ ok: true, provider: "claude-code", source: "default", warning: null });
    expect(byDefault).toMatchObject({
      note: expect.stringContaining(
        "prefers Codex, which can't fully lock a run down to read untrusted input and wasn't chosen for PR review, so Claude Code ran it.",
      ),
    });
    expect(
      resolveOperationModel("prReview", { task: task("deep") }, settings({ operationModels: { prReview: "inherit" } })),
    ).toMatchObject({
      ok: true,
      provider: "claude-code",
      source: "tier",
    });
    expect(
      resolveOperationModel(
        "issueImport",
        {},
        settings({ modelTiers: { ...tiers, light: { ...tiers.light, provider: "codex" } } }),
      ),
    ).toMatchObject({ ok: true, provider: "claude-code", warning: null });
    // Chosen on the Models page, the same tier does run there, with the warning.
    expect(
      resolveOperationModel("prReview", {}, { ...standardCodex, operationModels: { prReview: { tier: "standard" } } }),
    ).toMatchObject({
      ok: true,
      provider: "codex",
      source: "board",
      warning: expect.stringContaining("can't confine"),
    });
    // With only Codex on and nothing chosen, it refuses rather than run it there.
    expect(resolveOperationModel("prReview", {}, { ...standardCodex, providers: on("codex") })).toMatchObject({
      ok: false,
    });
    // The preferred provider switched off: no fallback to a warned one either.
    const deepOff = settings({ providers: [{ id: "codex", enabled: false }, ...on("claude-code")] });
    expect(resolveOperationModel("prReview", { automation: [{ tier: "deep" }] }, deepOff)).toMatchObject({
      ok: true,
      provider: "claude-code",
      warning: null,
    });
  });

  it("runs the structured operations of the user's own input on Codex", () => {
    const codexOnly = settings({ providers: on("codex") });
    for (const op of ["ask", "boardReviewer"] as const) {
      expect(resolveOperationModel(op, {}, codexOnly)).toMatchObject({ ok: true, provider: "codex", warning: null });
    }
    // A ticket import needs tool rules for the user's MCP servers, which only Claude Code follows.
    expect(resolveOperationModel("issueImport", { needs: IMPORT_TICKET_NEEDS }, codexOnly)).toMatchObject({
      ok: false,
    });
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
      "digest",
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
    expect(resolveOperationModel("digest", {}, settings({ providers: on("codex", "copilot-cli") }))).toEqual({
      ok: false,
      reason: "Digest needs a provider that can run with no tools; add one in Settings → Providers.",
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
      resolveOperationModel(
        "taskRun",
        { automation: [{ provider: "codex", model: "x", effort: "minimal" }] },
        settings(),
      ),
    ).toMatchObject({ ok: true, provider: "codex", model: "x", effort: null });
    expect(resolveOperationModel("orchestrate", {}, typed({ provider: "codex", model: "gpt-5.5" }))).toEqual({
      ok: false,
      reason: "Orchestrate is set to run on Codex, which can't follow tool rules of its own.",
    });
    // A typed model on a provider that only partly locks down runs, with the warning.
    const pr = resolveOperationModel(
      "prReview",
      {},
      settings({ operationModels: { prReview: { provider: "codex", model: "gpt-5.5" } } }),
    );
    expect(pr).toMatchObject({ ok: true, provider: "codex", warning: expect.stringContaining("can't confine") });
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
