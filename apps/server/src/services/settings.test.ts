import { describe, expect, it } from "vitest";
import { createRepos } from "../db/repos/index.ts";
import { createTestHarness } from "../test/harness.ts";

describe("custom models", () => {
  it("keeps the stored models that still parse when one doesn't, and the first of a repeated id", () => {
    const h = createTestHarness();
    const ok = { id: "fast", name: "Fast", labels: ["quick"], description: null, t3: null };
    createRepos(h.db).settings.set("modelProfiles", [ok, { id: "deep", name: "Bad" }, { ...ok, name: "Again" }, 7]);
    expect(h.services.settings.get().modelProfiles).toEqual([ok]);
    createRepos(h.db).settings.set("modelProfiles", "not a list");
    expect(h.services.settings.get().modelProfiles).toEqual([]);
  });
});

describe("CLI efforts", () => {
  const saved = (h: ReturnType<typeof createTestHarness>) => h.services.settings.get();

  it("saves a tier's and a custom model's effort with its model, and reads it back", () => {
    const h = createTestHarness();
    h.services.settings.update({
      modelTiers: {
        deep: { description: null, t3: null, cli: { "claude-code": "opus" }, cliEffort: { "claude-code": "max" } },
      },
      modelProfiles: [
        {
          id: "fast",
          name: "Fast",
          labels: [],
          description: null,
          t3: null,
          cli: { "copilot-cli": "gpt-5.4" },
          cliEffort: { "copilot-cli": "none" },
        },
      ],
    });
    expect(saved(h).modelTiers.deep.cliEffort).toEqual({ "claude-code": "max" });
    expect(saved(h).modelProfiles[0]?.cliEffort).toEqual({ "copilot-cli": "none" });
  });

  it("drops an effort once its model is cleared", () => {
    const h = createTestHarness();
    const deep = { description: null, t3: null };
    h.services.settings.update({
      modelTiers: { deep: { ...deep, cli: { "claude-code": "opus" }, cliEffort: { "claude-code": "max" } } },
    });
    h.services.settings.update({
      modelTiers: { deep: { ...deep, cli: { "claude-code": null }, cliEffort: { "claude-code": "max" } } },
    });
    expect(saved(h).modelTiers.deep).not.toHaveProperty("cliEffort");
  });

  it("refuses an effort the harness's CLI doesn't take", () => {
    const h = createTestHarness();
    const update = () =>
      h.services.settings.update({
        modelTiers: {
          light: {
            description: null,
            t3: null,
            cli: { "claude-code": "haiku" },
            cliEffort: { "claude-code": "minimal" },
          },
        },
      });
    expect(update).toThrow(/Claude Code has no effort minimal/);
  });
});

describe("headless job models", () => {
  it("defaults to haiku for imports and the CLI's own model for the board reviewer", () => {
    const { services } = createTestHarness();
    expect(services.settings.get()).toMatchObject({ issueImportModel: { model: "haiku" }, reviewModel: null });
  });

  it("reads a model saved as a bare string, as before tiers were an option", () => {
    const h = createTestHarness();
    createRepos(h.db).settings.set("issueImportModel", "claude-sonnet-5-5");
    createRepos(h.db).settings.set("reviewModel", "opus");
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { model: "claude-sonnet-5-5" },
      reviewModel: { model: "opus" },
    });
  });

  it("falls back to the default for a stored value that is neither a model nor a tier", () => {
    const h = createTestHarness();
    createRepos(h.db).settings.set("issueImportModel", { tier: "huge" });
    createRepos(h.db).settings.set("reviewModel", 7);
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { model: "haiku" },
      reviewModel: null,
    });
  });

  it("saves a tier or a model, and a string from an older client as a model", async () => {
    const h = createTestHarness();
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    await patch({ issueImportModel: { tier: "light" }, reviewModel: "sonnet" });
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { tier: "light" },
      reviewModel: { model: "sonnet" },
    });
    await patch({ issueImportModel: "haiku", reviewModel: null });
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { model: "haiku" },
      reviewModel: null,
    });
  });

  it("refuses a model that couldn't go on a command line, or a tier that doesn't exist", async () => {
    const h = createTestHarness();
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    expect((await patch({ issueImportModel: "haiku; rm -rf /" })).status).toBe(400);
    expect((await patch({ reviewModel: { tier: "huge" } })).status).toBe(400);
    expect((await patch({ issueImportModel: "" })).status).toBe(400);
  });
});

describe("hidden hand-off targets", () => {
  it("shows every target by default, and merges each switch so one doesn't undo another", async () => {
    const h = createTestHarness();
    expect(h.services.settings.get().handoffMenus).toEqual({
      "t3-code": true,
      "claude-code": true,
      "copilot-cli": true,
    });
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    await patch({ handoffMenus: { "copilot-cli": false } });
    await patch({ handoffMenus: { "t3-code": false } });
    expect(h.services.settings.get().handoffMenus).toEqual({
      "t3-code": false,
      "claude-code": true,
      "copilot-cli": false,
    });
    expect((await patch({ handoffMenus: { codex: false } })).status).toBe(400);
  });
});

describe("providers", () => {
  it("starts with none added, and saves the list with blank CLI paths as none", async () => {
    const h = createTestHarness();
    expect(h.services.settings.get().providers).toEqual([]);
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    const res = await patch({
      providers: [
        { id: "claude-code", enabled: true, cliPath: "  /opt/claude  " },
        { id: "t3-code", enabled: false, cliPath: "  " },
        { id: "codex", enabled: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(h.services.settings.get().providers).toEqual([
      { id: "claude-code", enabled: true, cliPath: "/opt/claude" },
      { id: "t3-code", enabled: false, cliPath: null },
      { id: "codex", enabled: true, cliPath: null },
    ]);
  });

  it("refuses a provider it doesn't know or one listed twice", async () => {
    const h = createTestHarness();
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    expect((await patch({ providers: [{ id: "gemini", enabled: true }] })).status).toBe(400);
    const twice = [
      { id: "codex", enabled: true },
      { id: "codex", enabled: false },
    ];
    expect((await patch({ providers: twice })).status).toBe(400);
  });

  it("skips stored entries that no longer parse, keeping the first of a repeated id", () => {
    const h = createTestHarness();
    createRepos(h.db).settings.set("providers", [
      { id: "codex", enabled: true, cliPath: "/opt/codex" },
      { id: "gemini", enabled: true },
      { id: "codex", enabled: false },
      "junk",
    ]);
    expect(h.services.settings.get().providers).toEqual([{ id: "codex", enabled: true, cliPath: "/opt/codex" }]);
  });

  it("publishes the new list, so open pages follow", () => {
    const h = createTestHarness();
    h.services.settings.update({ providers: [{ id: "copilot-cli", enabled: true }] });
    expect(h.events).toContainEqual({
      type: "providers.changed",
      providers: [{ id: "copilot-cli", enabled: true, cliPath: null }],
    });
    h.events.length = 0;
    h.services.settings.update({ githubPolling: false });
    expect(h.events.some((e) => e.type === "providers.changed")).toBe(false);
  });
});
