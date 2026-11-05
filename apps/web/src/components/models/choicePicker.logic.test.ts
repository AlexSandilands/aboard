import type { AgentModels, OperationSettings, ProviderSetting } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  choiceEffortColumn,
  choiceForPick,
  choicePickerModel,
  choiceRowKey,
  inheritDetail,
  modelLevels,
  parsePickKey,
  providerDisabledReason,
  resolvesTo,
  typedRows,
  type ChoicePickerInput,
} from "./choicePicker.logic";
import { CHOICES_TAB, rowDisabledReason, visibleRows } from "./modelPicker.logic";

const on = (...ids: ProviderSetting["id"][]): ProviderSetting[] => ids.map((id) => ({ id, enabled: true }));

const settings = (over: Partial<OperationSettings> = {}): OperationSettings => ({
  modelTiers: {
    light: { description: null, t3: null, cli: { "claude-code": "haiku" } },
    standard: { description: "Sonnet", t3: null, cli: { "claude-code": "sonnet", codex: "gpt-5.5" } },
    deep: { description: null, t3: null, cli: { codex: "gpt-5.5" }, cliEffort: { codex: "high" }, provider: "codex" },
  },
  modelProfiles: [{ id: "codex61", name: "Codex 6.1", labels: ["codex61"], description: null, t3: null }],
  operationModels: {},
  providers: on("claude-code", "codex"),
  ...over,
});

const scanned: AgentModels = {
  harnesses: [
    {
      harness: "claude-code",
      models: [
        { value: "opus", label: "Opus", description: "Most capable", effortLevels: ["low", "high", "max"] },
        { value: "haiku", label: "Haiku", description: null, effortLevels: [] },
      ],
      cliVersion: null,
      scannedAt: null,
      error: null,
    },
    { harness: "codex", models: [], cliVersion: null, scannedAt: null, error: "codex isn't scanned" },
  ],
};

const input = (over: Partial<ChoicePickerInput> = {}): ChoicePickerInput => ({
  settings: settings(),
  scanned,
  value: null,
  op: "boardReviewer",
  choices: true,
  inherit: { label: "Inherit", detail: "Claude Code · sonnet" },
  lockedProvider: null,
  ...over,
});

describe("choicePickerModel", () => {
  it("lists the choices tab, then each added provider with its scanned models", () => {
    const model = choicePickerModel(input());
    expect(model.tabs.map((t) => t.id)).toEqual([CHOICES_TAB, "claude-code", "codex"]);
    expect(model.rows.filter((r) => r.tab === CHOICES_TAB).map((r) => r.key)).toEqual([
      "inherit",
      "tier:light",
      "tier:standard",
      "tier:deep",
      "profile:codex61",
    ]);
    expect(model.rows.filter((r) => r.tab === "claude-code").map((r) => r.value)).toEqual(["opus", "haiku"]);
    expect(model.selectedKey).toBe("inherit");
  });

  it("says what each tier resolves to for the operation", () => {
    const model = choicePickerModel(input({ op: "orchestrate" }));
    const detail = (key: string) => model.rows.find((r) => r.key === key)?.detail;
    // Orchestrate needs tool rules, so the deep tier's Codex preference falls to Claude Code.
    expect(detail("tier:standard")).toBe("Claude Code · sonnet");
    expect(detail("tier:deep")).toBe("Claude Code · default model");
  });

  it("greys out a provider that can't do what the operation needs, with the reason", () => {
    const model = choicePickerModel(input({ op: "orchestrate" }));
    const codex = model.tabs.find((t) => t.id === "codex")!;
    expect(codex.disabledReason).toBe("Codex can't follow tool rules of its own, which Orchestrate needs.");
    expect(codex.warning).toBeNull();
    expect(codex.notice).toContain("codex isn't scanned");
    expect(codex.settingsTarget).toBe("providers.codex");
    expect(choicePickerModel(input({ op: "taskRun" })).tabs.find((t) => t.id === "codex")!.disabledReason).toBeNull();
  });

  it("offers a provider that only partly locks down, marked with its warning", () => {
    const pr = choicePickerModel(input({ op: "prReview" }));
    const codex = pr.tabs.find((t) => t.id === "codex")!;
    expect(codex.disabledReason).toBeNull();
    expect(codex.warning).toBe(
      "Codex can't confine its file reads, so text anyone can write (a pull request, an issue) could make it leak local files into what it returns. It runs PR review only when you choose it.",
    );
    expect(pr.tabs.find((t) => t.id === "claude-code")!.warning).toBeNull();
    // The deep tier prefers Codex, so choosing it runs there, with the warning.
    expect(pr.rows.find((r) => r.key === "tier:deep")?.detail).toMatch(/^Codex · .*, with a warning$/);
    // The user's own task diff: Codex runs the board reviewer without one.
    expect(choicePickerModel(input()).tabs.find((t) => t.id === "codex")).toMatchObject({
      disabledReason: null,
      warning: null,
    });
  });

  it("keeps a saved model the scan doesn't list, and a saved model's provider that isn't added", () => {
    const model = choicePickerModel(input({ op: "taskRun", value: { provider: "copilot-cli", model: "gpt-x" } }));
    expect(model.tabs.at(-1)!.id).toBe("copilot-cli");
    expect(model.tabs.at(-1)!.disabledReason).toBe("Copilot CLI isn't added. Add it in Settings → Providers.");
    expect(model.selectedKey).toBe("model:copilot-cli:gpt-x");
    expect(
      rowDisabledReason(
        model,
        model.rows.find((r) => r.key === "model:copilot-cli:gpt-x")!,
      ),
    ).toContain("isn't added");
  });

  it("lists a deleted custom model that is still saved", () => {
    const model = choicePickerModel(input({ value: { profile: "gone" } }));
    expect(model.rows.find((r) => r.key === "profile:gone")?.name).toBe("gone (deleted)");
    expect(model.selectedKey).toBe("profile:gone");
  });

  it("locked to one CLI, lists only its tab with the default row first", () => {
    const model = choicePickerModel(
      input({ choices: false, inherit: null, op: null, lockedProvider: "claude-code", defaultLabel: "CLI default" }),
    );
    expect(model.tabs.map((t) => t.id)).toEqual(["claude-code"]);
    expect(model.rows[0]).toMatchObject({ key: "default:claude-code", name: "CLI default", closes: true });
    expect(model.selectedKey).toBe("default:claude-code");
    // A model that takes no effort closes the popup when picked; one with levels leaves the column open.
    expect(model.rows.find((r) => r.value === "haiku")?.closes).toBe(true);
    expect(model.rows.find((r) => r.value === "opus")?.closes).toBe(false);
  });

  it("names a provider switched off, and one another provider is locked out by", () => {
    const off = settings({ providers: [{ id: "claude-code", enabled: false }] });
    expect(providerDisabledReason("claude-code", { settings: off, op: null, lockedProvider: null })).toBe(
      "Claude Code is switched off in Settings → Providers.",
    );
    expect(providerDisabledReason("codex", { settings: settings(), op: null, lockedProvider: "claude-code" })).toBe(
      "Only Claude Code models can be picked here.",
    );
  });
});

describe("visibleRows", () => {
  it("searches every tab and ranks the closest name first", () => {
    const model = choicePickerModel(input({ op: "taskRun" }));
    const shown = visibleRows(model, CHOICES_TAB, "opus", new Set());
    expect(shown.keys[0]).toBe("model:claude-code:opus");
    expect(visibleRows(model, CHOICES_TAB, "deep", new Set()).keys).toEqual(["tier:deep"]);
  });

  it("shows one tab's rows without a search", () => {
    const model = choicePickerModel(input());
    expect(visibleRows(model, "claude-code", "", new Set()).keys).toEqual([
      "model:claude-code:opus",
      "model:claude-code:haiku",
    ]);
  });
});

describe("typedRows", () => {
  it("offers the search text on every provider that can run it, unless it lists that model", () => {
    const model = choicePickerModel(input({ op: "taskRun" }));
    expect(typedRows(model, "gpt-6", CHOICES_TAB).rows.map((r) => r.key)).toEqual([
      "typed:claude-code:gpt-6",
      "typed:codex:gpt-6",
    ]);
    expect(typedRows(model, "gpt-6", "codex").rows.map((r) => r.key)).toEqual(["typed:codex:gpt-6"]);
    expect(typedRows(model, "opus", "claude-code").rows).toEqual([]);
  });

  it("leaves out providers that can't run the operation, and refuses what can't be a model", () => {
    const model = choicePickerModel(input({ op: "orchestrate" }));
    expect(typedRows(model, "gpt-6", CHOICES_TAB).rows.map((r) => r.tab)).toEqual(["claude-code"]);
    expect(typedRows(model, "rm -rf", CHOICES_TAB).error).toMatch(/letters, digits/);
  });
});

describe("picks", () => {
  it("reads each kind of key back", () => {
    expect(parsePickKey("inherit")).toEqual({ kind: "inherit" });
    expect(parsePickKey("tier:deep")).toEqual({ kind: "tier", tier: "deep" });
    expect(parsePickKey("profile:codex61")).toEqual({ kind: "profile", id: "codex61" });
    expect(parsePickKey("model:codex:gpt-5.5:fast")).toEqual({
      kind: "model",
      provider: "codex",
      model: "gpt-5.5:fast",
    });
    expect(parsePickKey("typed:codex:x")).toEqual({ kind: "model", provider: "codex", model: "x" });
    expect(parsePickKey("default:codex")).toEqual({ kind: "model", provider: "codex", model: null });
    expect(parsePickKey("legacy:codex")).toBeNull();
    expect(choiceRowKey({ provider: "codex", model: "gpt-5.5", effort: "high" })).toBe("model:codex:gpt-5.5");
  });

  it("keeps the effort on the same provider while the new model takes it", () => {
    const current = { provider: "claude-code" as const, model: "sonnet", effort: "high" as const };
    expect(choiceForPick({ kind: "model", provider: "claude-code", model: "opus" }, current, scanned)).toEqual({
      provider: "claude-code",
      model: "opus",
      effort: "high",
    });
    expect(choiceForPick({ kind: "model", provider: "claude-code", model: "haiku" }, current, scanned)).toEqual({
      provider: "claude-code",
      model: "haiku",
    });
    expect(choiceForPick({ kind: "model", provider: "codex", model: "gpt" }, current, scanned)).toEqual({
      provider: "codex",
      model: "gpt",
    });
    expect(choiceForPick({ kind: "tier", tier: "light" }, current, scanned)).toEqual({ tier: "light" });
  });
});

describe("choiceEffortColumn", () => {
  it("lists Default and the model's levels, keeping a saved level it no longer lists", () => {
    const column = choiceEffortColumn(
      { kind: "model", provider: "claude-code", model: "opus" },
      "medium",
      scanned,
      "Opus",
    );
    expect(column.groups[0]!.options.map((o) => o.id)).toEqual([null, "medium", "low", "high", "max"]);
    expect(column.groups[0]!.value).toBe("medium");
  });

  it("falls back to the CLI's levels for a model the scan doesn't list", () => {
    const column = choiceEffortColumn({ kind: "model", provider: "codex", model: "gpt-x" }, null, scanned, "gpt-x");
    expect(column.groups[0]!.options.map((o) => o.id)).toEqual([null, "low", "medium", "high", "xhigh"]);
  });

  it("says where the effort comes from for anything that isn't one model", () => {
    expect(choiceEffortColumn({ kind: "tier", tier: "deep" }, null, scanned, "").note).toMatch(/tier/);
    expect(choiceEffortColumn({ kind: "model", provider: "claude-code", model: "haiku" }, null, scanned, "").note).toBe(
      "This model takes no effort.",
    );
  });
});

describe("resolvesTo", () => {
  it("names the provider, model and effort, and where the choice came from", () => {
    expect(resolvesTo("boardReviewer", {}, settings()).text).toBe(
      "Resolves to Claude Code · sonnet, from the Standard tier (the default).",
    );
    const typed = settings({ operationModels: { digest: { provider: "claude-code", model: "opus", effort: "max" } } });
    expect(resolvesTo("digest", {}, typed).text).toBe("Resolves to Claude Code · opus (max), set on the Models page.");
  });

  it("passes on the resolver's note and its refusal", () => {
    const deep = settings({ operationModels: { orchestrate: { tier: "deep" } } });
    expect(resolvesTo("orchestrate", {}, deep).note).toMatch(/prefers Codex/);
    const refused = resolvesTo("orchestrate", {}, settings({ providers: on("codex") }));
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/needs a provider that can/);
  });

  it("says an operation on a task falls to the task's own model when nothing is set", () => {
    expect(resolvesTo("taskRun", {}, settings()).text).toMatch(/task's own model/);
    expect(inheritDetail("taskRun", {}, settings())).toBe("The task's own model");
  });
});

describe("modelLevels", () => {
  it("lists a model's levels, and none for the CLI's default model, so an effort can't ride along hidden", () => {
    expect(modelLevels(scanned, "claude-code", "opus")).toEqual(["low", "high", "max"]);
    expect(modelLevels(scanned, "codex", "gpt-x")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(modelLevels(scanned, "claude-code", null)).toEqual([]);
  });
});
