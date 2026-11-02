import { afterEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "@repo/contracts";
import { DEFAULT_STAGE_BANNER } from "~/components/stage/stageBanner.logic";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("appearance persistence", () => {
  it.each(["wires", "unknown-banner", null, undefined, "aurora", "rotate"])(
    "validates saved banner %s on hydration",
    async (banner) => {
      const data = new Map([
        [storageKey("appearance"), JSON.stringify({ state: { banner, scrollToTask: false }, version: 0 })],
      ]);
      vi.stubGlobal("window", {
        localStorage: {
          getItem: (key: string) => data.get(key) ?? null,
          setItem: (key: string, value: string) => void data.set(key, value),
          removeItem: (key: string) => void data.delete(key),
        },
      });
      vi.resetModules();
      const { useAppearance } = await import("./ui");
      await useAppearance.persist.rehydrate();
      expect(useAppearance.getState()).toMatchObject({
        banner: banner === "aurora" || banner === "rotate" ? banner : DEFAULT_STAGE_BANNER,
        scrollToTask: false,
      });
    },
  );
});
