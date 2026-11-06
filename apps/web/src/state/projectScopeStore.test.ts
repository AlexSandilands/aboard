import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fresh `ui.ts` over an in-memory localStorage that holds `stored` raw (the node test env has none). */
async function loadStore(stored: unknown) {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => void data.set(name, value),
      removeItem: (name: string) => void data.delete(name),
    },
  });
  vi.resetModules();
  const { storageKey } = await import("@repo/contracts");
  const key = storageKey("project-scope");
  if (stored !== undefined) data.set(key, JSON.stringify({ state: stored, version: 0 }));
  const { useProjectScope } = await import("./ui");
  await useProjectScope.persist.rehydrate();
  return { useProjectScope, saved: () => JSON.parse(data.get(key) ?? "null") as { state: object } | null };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useProjectScope", () => {
  it("starts on every project", async () => {
    const { useProjectScope } = await loadStore(undefined);
    expect(useProjectScope.getState().projectIds).toEqual([]);
  });

  it("writes the scope to storage and clears it for All projects", async () => {
    const { useProjectScope, saved } = await loadStore(undefined);
    useProjectScope.getState().setProjectIds(["a", "b"]);
    expect(saved()?.state).toEqual({ projectIds: ["a", "b"] });
    useProjectScope.getState().setProjectIds([]);
    expect(saved()?.state).toEqual({ projectIds: [] });
  });

  it("reads the stored scope back on the next start", async () => {
    const { useProjectScope } = await loadStore({ projectIds: ["a", "b"] });
    expect(useProjectScope.getState().projectIds).toEqual(["a", "b"]);
  });

  it("ignores a stored value that isn't a list of ids", async () => {
    for (const bad of [{ projectIds: "a,b" }, { projectIds: [1, 2] }, {}]) {
      const { useProjectScope } = await loadStore(bad);
      expect(useProjectScope.getState().projectIds).toEqual([]);
    }
  });
});
