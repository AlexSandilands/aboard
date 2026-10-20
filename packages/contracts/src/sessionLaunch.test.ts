import { describe, expect, it } from "vitest";
import { BRAND } from "./brand.ts";
import { EMPTY_MODEL_TIERS, ModelTiers } from "./modelTiers.ts";
import {
  CliModel,
  isTaskWindowName,
  newSessionArgv,
  sessionLabel,
  taskWindowName,
  tierCliEffort,
  tierCliModel,
} from "./sessionLaunch.ts";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";

describe("new session argv", () => {
  it("passes Claude Code the prompt as its last argument, after the model, id and name", () => {
    expect(
      newSessionArgv({ harness: "claude-code", sessionId: ID, model: "opus", name: "Implementing #4", prompt: "Go" }),
    ).toEqual(["claude", "--model", "opus", "--session-id", ID, "--name", "Implementing #4", "--", "Go"]);
  });

  it("starts Copilot CLI interactively with -i, and leaves the model out for the CLI's default", () => {
    expect(
      newSessionArgv({ harness: "copilot-cli", sessionId: ID, model: null, name: "Planning #4", prompt: "Plan" }),
    ).toEqual(["copilot", "--session-id", ID, "--name", "Planning #4", "-i", "Plan"]);
  });

  it("passes the effort after the model, as each CLI names the flag", () => {
    expect(
      newSessionArgv({
        harness: "claude-code",
        sessionId: ID,
        model: "opus",
        effort: "high",
        name: "Implementing #4",
        prompt: "Go",
      }),
    ).toEqual([
      "claude",
      "--model",
      "opus",
      "--effort",
      "high",
      "--session-id",
      ID,
      "--name",
      "Implementing #4",
      "--",
      "Go",
    ]);
    expect(
      newSessionArgv({
        harness: "copilot-cli",
        sessionId: ID,
        model: "gpt-5.4",
        effort: "none",
        name: "Planning #4",
        prompt: "Plan",
      }),
    ).toEqual([
      "copilot",
      "--model",
      "gpt-5.4",
      "--reasoning-effort",
      "none",
      "--session-id",
      ID,
      "--name",
      "Planning #4",
      "-i",
      "Plan",
    ]);
    // An effort alone is still passed: the CLI applies it to its default model.
    expect(
      newSessionArgv({
        harness: "claude-code",
        sessionId: ID,
        model: null,
        effort: "low",
        name: "n",
        prompt: "p",
      }).slice(0, 3),
    ).toEqual(["claude", "--effort", "low"]);
    expect(
      newSessionArgv({ harness: "claude-code", sessionId: ID, model: null, effort: null, name: "n", prompt: "p" }),
    ).not.toContain("--effort");
  });

  it("labels sessions by mode", () => {
    expect(sessionLabel("work", 4)).toBe("Implementing #4");
    expect(sessionLabel("plan", 4)).toBe("Planning #4");
    expect(sessionLabel("orchestrate", 4)).toBe("Orchestrating #4");
  });
});

describe("models and windows", () => {
  it.each(["opus", "claude-opus-5-5[1m]", "gpt-5.4", "anthropic/claude@latest"])("accepts the model %s", (m) =>
    expect(CliModel.safeParse(m).success).toBe(true),
  );
  it.each(["opus; calc", "a b", '"x"', "$(x)", "50%"])("refuses the model %j", (m) =>
    expect(CliModel.safeParse(m).success).toBe(false),
  );

  it("reads a tier's model for a CLI, treating blank or no tier as the CLI's default", () => {
    const tiers = {
      ...EMPTY_MODEL_TIERS,
      deep: { description: null, t3: null, cli: { "claude-code": "opus", "copilot-cli": "  " } },
    };
    expect(tierCliModel(tiers, "deep", "claude-code")).toBe("opus");
    expect(tierCliModel(tiers, "deep", "copilot-cli")).toBeNull();
    expect(tierCliModel(tiers, "light", "claude-code")).toBeNull();
    expect(tierCliModel(tiers, null, "claude-code")).toBeNull();
  });

  it("reads a tier's effort for a CLI only while it has a model there", () => {
    const tiers = ModelTiers.parse({
      ...EMPTY_MODEL_TIERS,
      deep: {
        description: null,
        t3: null,
        cli: { "claude-code": "opus" },
        cliEffort: { "claude-code": "max", "copilot-cli": "low" },
      },
    });
    expect(tierCliEffort(tiers, "deep", "claude-code")).toBe("max");
    expect(tierCliEffort(tiers, "deep", "copilot-cli")).toBeNull();
    expect(tierCliEffort(tiers, "light", "claude-code")).toBeNull();
    expect(tierCliEffort(tiers, null, "claude-code")).toBeNull();
  });

  it("names a task's window after the product and the task, in characters wt takes as a name", () => {
    expect(taskWindowName(115)).toBe(`${BRAND.id}-115`);
    expect(isTaskWindowName(taskWindowName(115))).toBe(true);
    expect(isTaskWindowName("0")).toBe(false);
    expect(isTaskWindowName("new")).toBe(false);
    expect(isTaskWindowName("a b")).toBe(false);
    expect(isTaskWindowName("x;new-tab")).toBe(false);
  });
});
