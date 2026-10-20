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

describe("headless job models", () => {
  it("defaults to haiku for imports and the CLI's own model for the board reviewer", () => {
    const { services } = createTestHarness();
    expect(services.settings.get()).toMatchObject({ issueImportModel: { model: "haiku" }, headlessReviewModel: null });
  });

  it("reads a model saved as a bare string, as before tiers were an option", () => {
    const h = createTestHarness();
    createRepos(h.db).settings.set("issueImportModel", "claude-sonnet-5-5");
    createRepos(h.db).settings.set("headlessReviewModel", "opus");
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { model: "claude-sonnet-5-5" },
      headlessReviewModel: { model: "opus" },
    });
  });

  it("falls back to the default for a stored value that is neither a model nor a tier", () => {
    const h = createTestHarness();
    createRepos(h.db).settings.set("issueImportModel", { tier: "huge" });
    createRepos(h.db).settings.set("headlessReviewModel", 7);
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { model: "haiku" },
      headlessReviewModel: null,
    });
  });

  it("saves a tier or a model, and a string from an older client as a model", async () => {
    const h = createTestHarness();
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    await patch({ issueImportModel: { tier: "light" }, headlessReviewModel: "sonnet" });
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { tier: "light" },
      headlessReviewModel: { model: "sonnet" },
    });
    await patch({ issueImportModel: "haiku", headlessReviewModel: null });
    expect(h.services.settings.get()).toMatchObject({
      issueImportModel: { model: "haiku" },
      headlessReviewModel: null,
    });
  });

  it("refuses a model that couldn't go on a command line, or a tier that doesn't exist", async () => {
    const h = createTestHarness();
    const patch = (json: unknown) => h.request("/api/settings", { method: "PATCH", json });
    expect((await patch({ issueImportModel: "haiku; rm -rf /" })).status).toBe(400);
    expect((await patch({ headlessReviewModel: { tier: "huge" } })).status).toBe(400);
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
