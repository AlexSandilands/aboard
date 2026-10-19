import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "board-view";

/** A fresh `ui.ts` over an in-memory localStorage that holds `stored` (the node test env has none). */
async function loadStore(stored: object | null) {
  const data = new Map<string, string>();
  // zustand reads `window.localStorage`.
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (name: string) => data.get(name) ?? null,
      setItem: (name: string, value: string) => void data.set(name, value),
      removeItem: (name: string) => void data.delete(name),
    },
  });
  vi.resetModules();
  const { storageKey } = await import("@repo/contracts");
  const key = storageKey(KEY);
  if (stored) data.set(key, JSON.stringify({ state: stored, version: 2 }));
  const { useBoardView } = await import("./ui");
  await useBoardView.persist.rehydrate();
  return { useBoardView, saved: () => JSON.parse(data.get(key) ?? "null") as { state: object } | null };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("board view persistence", () => {
  it("gives a view saved before the pin settings their defaults", async () => {
    const { useBoardView } = await loadStore({
      showPriorityLane: false,
      collapsedColumns: { done: true },
      cellOverrides: {},
    });
    expect(useBoardView.getState()).toMatchObject({
      showPriorityLane: false,
      pinPriorityLane: false,
      pinnedLaneHeight: "medium",
    });
  });

  it("keeps stored pin settings and saves changes to them", async () => {
    const { useBoardView, saved } = await loadStore({ pinPriorityLane: true, pinnedLaneHeight: "small" });
    expect(useBoardView.getState()).toMatchObject({ pinPriorityLane: true, pinnedLaneHeight: "small" });
    useBoardView.getState().setPinnedLaneHeight("large");
    useBoardView.getState().setPinPriorityLane(false);
    expect(saved()?.state).toMatchObject({ pinPriorityLane: false, pinnedLaneHeight: "large" });
  });
});
