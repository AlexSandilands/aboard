import type { T3ModelCatalog } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { adjacentTab, FAVORITES_TAB, initialTab, legacyKey, visibleRows, type PickerTab } from "./modelPicker.logic";
import { rankModelPickerSearch, scoreModelPickerSearch } from "./modelPickerSearch.logic";
import { parseT3RowKey, t3EffortColumn, t3PickerModel, t3RowKey, t3SelectionForKey } from "./t3Picker.logic";

const catalog: T3ModelCatalog = {
  providers: [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      ready: true,
      message: null,
      supportedRuntimeModes: [],
      models: [
        {
          slug: "claude-opus",
          name: "Claude Opus",
          badge: "new",
          isLegacy: false,
          isDefault: true,
          options: [
            {
              type: "select",
              id: "effort",
              label: "Reasoning",
              options: [
                { id: "low", label: "Low", isDefault: false },
                { id: "high", label: "High", isDefault: true },
              ],
              currentValue: null,
            },
            { type: "boolean", id: "fastMode", label: "Fast mode", currentValue: false },
          ],
        },
        { slug: "claude-old", name: "Claude Old", badge: null, isLegacy: true, isDefault: false, options: [] },
      ],
    },
    {
      instanceId: "codex",
      driver: "codex",
      displayName: "Codex",
      ready: false,
      message: "Sign in to Codex",
      supportedRuntimeModes: [],
      models: [{ slug: "gpt-5.5", name: "GPT-5.5", badge: null, isLegacy: false, isDefault: true, options: [] }],
    },
  ],
  favorites: [{ instanceId: "codex", model: "gpt-5.5" }],
};

describe("modelPickerSearch", () => {
  it("ranks an exact name first, then prefixes, then letters in order", () => {
    const rows = ["Sonnet", "Claude Sonnet 5.5", "Sonnet[1m]", "Haiku"].map((name) => ({
      name,
      providerName: "Claude",
    }));
    expect(rankModelPickerSearch(rows, "sonnet", (r) => r).map((r) => r.name)).toEqual([
      "Sonnet",
      "Sonnet[1m]",
      "Claude Sonnet 5.5",
    ]);
    expect(scoreModelPickerSearch({ name: "Claude Sonnet", providerName: "Claude" }, "clsn")).not.toBeNull();
    expect(scoreModelPickerSearch({ name: "Haiku", providerName: "Claude" }, "opus")).toBeNull();
  });

  it("needs every word to match somewhere, the provider's name included", () => {
    const row = { name: "GPT-5.5", value: "gpt-5.5", providerName: "Codex" };
    expect(scoreModelPickerSearch(row, "codex gpt")).not.toBeNull();
    expect(scoreModelPickerSearch(row, "claude gpt")).toBeNull();
  });
});

describe("t3PickerModel", () => {
  const model = t3PickerModel(catalog, { instanceId: "claudeAgent", model: "claude-opus", options: [] });

  it("lists Favorites first, then T3's providers, a provider that isn't ready greyed out", () => {
    expect(model.tabs.map((t) => t.id)).toEqual([FAVORITES_TAB, "claudeAgent", "codex"]);
    expect(model.tabs[2]!.disabledReason).toBe("Sign in to Codex");
    expect(model.selectedKey).toBe(t3RowKey("claudeAgent", "claude-opus"));
    expect(initialTab(model)).toBe("claudeAgent");
  });

  it("folds legacy models under a toggle, and shows favorites from every provider", () => {
    const shown = visibleRows(model, "claudeAgent", "", new Set());
    expect(shown.keys).toEqual([t3RowKey("claudeAgent", "claude-opus"), legacyKey("claudeAgent")]);
    expect(shown.legacy).toEqual({ key: legacyKey("claudeAgent"), expanded: false, count: 1 });
    expect(visibleRows(model, "claudeAgent", "", new Set(["claudeAgent"])).keys).toHaveLength(3);
    expect(visibleRows(model, FAVORITES_TAB, "", new Set()).keys).toEqual([t3RowKey("codex", "gpt-5.5")]);
  });

  it("reads a row's key back, even when the instance holds a colon", () => {
    expect(parseT3RowKey(t3RowKey("a:b", "m:1"))).toEqual({ instanceId: "a:b", slug: "m:1" });
  });

  it("keeps the options the new model takes and builds the effort column from them", () => {
    const selection = t3SelectionForKey(
      catalog,
      { instanceId: "codex", model: "gpt-5.5", options: [{ id: "effort", value: "low" }] },
      t3RowKey("claudeAgent", "claude-opus"),
    )!;
    expect(selection.options).toEqual([{ id: "effort", value: "low" }]);
    const column = t3EffortColumn(catalog, selection);
    expect(column.groups[0]).toMatchObject({ label: "Reasoning", value: "low" });
    expect(column.toggles).toEqual([{ id: "fastMode", label: "Fast mode", checked: false }]);
  });
});

describe("adjacentTab", () => {
  const tabs = ["a", "b", "c"].map((id): PickerTab => ({
    id,
    label: id,
    icon: { kind: "choices" },
    disabledReason: id === "b" ? "no" : null,
    notice: null,
    warning: null,
    settingsTarget: null,
    typed: false,
  }));
  it("skips disabled tabs and wraps", () => {
    expect(adjacentTab(tabs, "a", 1)).toBe("c");
    expect(adjacentTab(tabs, "c", 1)).toBe("a");
    expect(adjacentTab(tabs, "a", -1)).toBe("c");
  });
});

describe("modelPickerSearch descriptions", () => {
  it("matches a description by its words, not by scattered letters", () => {
    const row = { name: "Haiku", detail: "Fastest for quick answers", providerName: "Claude Code" };
    expect(scoreModelPickerSearch(row, "son")).toBeNull();
    expect(scoreModelPickerSearch(row, "quick")).not.toBeNull();
  });
});
