import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PRICES_AS_OF, type ModelPricesStatus } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import {
  createModelPriceService,
  LITELLM_PRICES_API_URL,
  LITELLM_PRICES_URL,
  PRICES_FLOOR_MS,
  PRICES_TTL_MS,
} from "./modelPrices.ts";
import type { FetchFn } from "./t3.ts";

const DOC = {
  "claude-opus-5-5": {
    litellm_provider: "anthropic",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
  },
};
const T0 = Date.parse("2026-11-11T09:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { respond?: (url: string) => Response | Promise<Response>; enabled?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "model-prices-"));
  dirs.push(dir);
  const cachePath = join(dir, "model-prices.json");
  const calls: Array<{ url: string; accept: string | null }> = [];
  let clock = T0;
  let enabled = opts.enabled ?? true;
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, accept: new Headers(init?.headers).get("accept") });
    return opts.respond ? opts.respond(url) : Response.json(DOC);
  };
  const make = () =>
    createModelPriceService({
      cachePath,
      fetch,
      enabled: () => enabled,
      now: () => new Date(clock),
      log: { warn: () => {} },
    });
  return {
    cachePath,
    calls,
    make,
    advance: (ms: number) => (clock += ms),
    setEnabled: (on: boolean) => (enabled = on),
  };
}

describe("model price service", () => {
  it("uses the built-in table until a list is fetched, then LiteLLM's, and keeps it on disk", async () => {
    const t = setup();
    const service = t.make();
    expect(service.current()).toEqual({
      table: null,
      source: { source: "built_in", asOf: MODEL_PRICES_AS_OF, status: "unavailable" },
    });
    const status = await service.refresh();
    expect(status).toMatchObject({ source: "litellm", status: "fresh", models: 1, asOf: new Date(T0).toISOString() });
    expect(t.calls).toEqual([{ url: LITELLM_PRICES_URL, accept: "application/json" }]);
    expect(service.current().table?.entries[0]?.price.input).toBe(3);
    const saved = JSON.parse(readFileSync(t.cachePath, "utf8")) as { fetchedAt: string; document: unknown };
    expect(saved).toEqual({ fetchedAt: new Date(T0).toISOString(), document: DOC });
  });

  it("falls back to GitHub's API when the raw file can't be fetched", async () => {
    const t = setup({
      respond: (url) => (url === LITELLM_PRICES_URL ? new Response("", { status: 503 }) : Response.json(DOC)),
    });
    expect((await t.make().refresh()).status).toBe("fresh");
    expect(t.calls.map((c) => c.url)).toEqual([LITELLM_PRICES_URL, LITELLM_PRICES_API_URL]);
    expect(t.calls[1]!.accept).toBe("application/vnd.github.raw+json");
  });

  it("reads the copy on disk after a restart, without fetching while it is under a day old", async () => {
    const t = setup();
    await t.make().refresh();
    t.advance(60 * 60_000);
    const restarted = t.make();
    expect((await restarted.refresh()).status).toBe("cached");
    expect(t.calls).toHaveLength(1);
    t.advance(PRICES_TTL_MS);
    expect((await restarted.refresh()).status).toBe("fresh");
    expect(t.calls).toHaveLength(2);
  });

  it("says cached when a fetch fails with a list kept, and unavailable with none", async () => {
    let ok = true;
    const t = setup({ respond: () => (ok ? Response.json(DOC) : Promise.reject(new Error("offline"))) });
    const service = t.make();
    await service.refresh();
    ok = false;
    t.advance(PRICES_TTL_MS);
    const status = await service.refresh();
    expect(status).toMatchObject({
      source: "litellm",
      status: "cached",
      lastFailedAt: new Date(T0 + PRICES_TTL_MS).toISOString(),
    });

    const empty = setup({ respond: () => Promise.reject(new Error("offline")) });
    expect(await empty.make().refresh()).toMatchObject({ source: "built_in", status: "unavailable" });
  });

  it("forces a refresh at most once a minute, and waits a minute after a failure", async () => {
    let ok = true;
    const t = setup({ respond: () => (ok ? Response.json(DOC) : new Response("", { status: 500 })) });
    const service = t.make();
    await service.refresh();
    await service.refresh({ force: true });
    expect(t.calls).toHaveLength(1);
    t.advance(PRICES_FLOOR_MS);
    ok = false;
    await service.refresh({ force: true });
    expect(t.calls).toHaveLength(3); // both URLs failed
    t.advance(PRICES_FLOOR_MS / 2);
    await service.refresh({ force: true });
    expect(t.calls).toHaveLength(3);
    t.advance(PRICES_FLOOR_MS / 2);
    ok = true;
    expect((await service.refresh({ force: true })).status).toBe("fresh");
  });

  it("shares a fetch already in flight", async () => {
    const t = setup();
    const service = t.make();
    await Promise.all([service.refresh(), service.refresh(), service.refresh({ force: true })]);
    expect(t.calls).toHaveLength(1);
  });

  it("ignores a corrupt copy on disk", async () => {
    const t = setup();
    writeFileSync(t.cachePath, "{not json");
    const service = t.make();
    expect(service.status().status).toBe("unavailable");
    expect((await service.refresh()).status).toBe("fresh");
  });

  it("keeps the last list when a response has no usable prices", async () => {
    let doc: unknown = DOC;
    const t = setup({ respond: () => Response.json(doc) });
    const service = t.make();
    await service.refresh();
    doc = { "azure/gpt-6": { litellm_provider: "azure", input_cost_per_token: 1, output_cost_per_token: 1 } };
    t.advance(PRICES_TTL_MS);
    expect((await service.refresh()).status).toBe("cached");
    const saved = JSON.parse(readFileSync(t.cachePath, "utf8")) as { document: unknown };
    expect(saved.document).toEqual(DOC);
  });

  it("fetches nothing and uses no fetched price when switched off", async () => {
    const t = setup();
    const service = t.make();
    await service.refresh();
    t.setEnabled(false);
    t.advance(PRICES_TTL_MS);
    expect(await service.refresh({ force: true })).toMatchObject({ source: "built_in", status: "off" });
    expect(service.current().table).toBeNull();
    expect(t.calls).toHaveLength(1);
  });
});

describe("model price routes", () => {
  it("report the status, refresh without the network in tests, and price task usage from the built-in table", async () => {
    const { request } = createTestHarness();
    const status = await (await request("/api/model-prices")).json();
    expect(status).toMatchObject({ source: "built_in", status: "unavailable", models: null });
    const refreshed = (await (
      await request("/api/model-prices/refresh", { method: "POST" })
    ).json()) as ModelPricesStatus;
    expect(refreshed).toMatchObject({ status: "unavailable" });
    expect(refreshed.lastFailedAt).not.toBeNull();
    await request("/api/settings", { method: "PATCH", json: { modelPriceFetch: false } });
    expect(await (await request("/api/model-prices")).json()).toMatchObject({ status: "off" });
  });
});
