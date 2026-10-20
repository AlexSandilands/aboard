import type { ModelProfile } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  applyProfileEdit,
  createProfileEdits,
  labelConflicts,
  parseLabelList,
  profileIdFor,
  saveProfileEdit,
} from "./modelProfiles.logic";

const profile = (id: string, labels: string[] = []): ModelProfile => ({
  id,
  name: id.toUpperCase(),
  labels,
  description: null,
  t3: null,
});

describe("custom models editor", () => {
  it("makes an id from the name that is unique and never a tier's name", () => {
    expect(profileIdFor("Codex 6.1", new Set())).toBe("codex-6-1");
    expect(profileIdFor("Codex 6.1", new Set(["codex-6-1"]))).toBe("codex-6-1-2");
    expect(profileIdFor("Deep", new Set())).toBe("deep-model");
    expect(profileIdFor("!!!", new Set())).toBe("model");
  });

  it("reads a comma-separated label list as task labels", () => {
    expect(parseLabelList("Codex61, #fast lane, codex61, ")).toEqual(["codex61", "fast-lane"]);
  });

  it("adds, renames, moves and removes models", () => {
    let list = applyProfileEdit([], { kind: "add", name: "Codex 6.1" });
    expect(list).toEqual([{ id: "codex-6-1", name: "Codex 6.1", labels: [], description: null, t3: null }]);
    list = applyProfileEdit(list, { kind: "add", name: "" });
    expect(list[1]).toMatchObject({ id: "new-model", name: "New model" });
    list = applyProfileEdit(list, { kind: "change", id: "new-model", change: { field: "name", value: "Fast" } });
    list = applyProfileEdit(list, {
      kind: "change",
      id: "new-model",
      change: { field: "cli", harness: "claude-code", value: "haiku" },
    });
    expect(list[1]).toMatchObject({ name: "Fast", cli: { "claude-code": "haiku" } });
    // A blank name keeps the old one.
    list = applyProfileEdit(list, { kind: "change", id: "new-model", change: { field: "name", value: " " } });
    expect(list[1]!.name).toBe("Fast");
    list = applyProfileEdit(list, { kind: "move", id: "new-model", delta: -1 });
    expect(list.map((p) => p.id)).toEqual(["new-model", "codex-6-1"]);
    expect(applyProfileEdit(list, { kind: "move", id: "new-model", delta: -1 })).toEqual(list);
    expect(applyProfileEdit(list, { kind: "remove", id: "codex-6-1" }).map((p) => p.id)).toEqual(["new-model"]);
  });

  it("says which model wins a label several claim", () => {
    expect(labelConflicts([profile("a", ["x", "y"]), profile("b", ["x"]), profile("c", ["y"])])).toEqual([
      { label: "x", winner: "A", shadowed: ["B"] },
      { label: "y", winner: "A", shadowed: ["C"] },
    ]);
  });

  it("builds an edit on the list still being saved, not the stale cache", async () => {
    const edits = createProfileEdits();
    const sent: ModelProfile[][] = [];
    const send = (update: { modelProfiles: ModelProfile[] }) => {
      sent.push(update.modelProfiles);
      return Promise.resolve();
    };
    // Both edits start before either save settles, as two quick edits do.
    const saves = [
      saveProfileEdit(edits, send, [], { kind: "add", name: "A" }),
      saveProfileEdit(edits, send, [], { kind: "add", name: "B" }),
    ];
    expect(sent[1]!.map((p) => p.name)).toEqual(["A", "B"]);
    await Promise.all(saves);
    // Once nothing is in flight, the cache is current again.
    await saveProfileEdit(edits, send, [], { kind: "add", name: "C" });
    expect(sent[2]!.map((p) => p.name)).toEqual(["C"]);
  });
});
