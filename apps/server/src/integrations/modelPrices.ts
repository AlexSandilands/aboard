import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  MODEL_PRICES_AS_OF,
  parseLiteLlmPrices,
  type ModelPricesStatus,
  type PriceSource,
  type PriceTable,
} from "@repo/contracts";
import { z } from "zod";
import type { FetchFn } from "./t3.ts";
import { messageOf, type Logger } from "./util.ts";

// Model prices from LiteLLM's list, fetched once a day and kept on disk so a restart or being offline still has them
// (docs/features/token-usage.md). Usage pricing reads current(); nothing here blocks a read on the network.

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
/** The same file through GitHub's API, for when raw.githubusercontent.com is blocked or down. */
export const LITELLM_PRICES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

export const PRICES_TTL_MS = 24 * 60 * 60_000;
/** A forced refresh at most this often, and at least this long after a failed fetch. */
export const PRICES_FLOOR_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** How often the timer checks whether the list is a day old; hourly, so a laptop waking from sleep catches up. */
const CHECK_EVERY_MS = 60 * 60_000;

/** `<data dir>/model-prices.json`: the raw document, re-parsed on start so a parser fix applies without a fetch. */
const CacheFile = z.object({ fetchedAt: z.string(), document: z.unknown() });

export interface ModelPriceService {
  /** The fetched table usage pricing uses (null when off or there is none) and where prices come from. */
  current(): { table: PriceTable | null; source: PriceSource };
  status(): ModelPricesStatus;
  /** Fetches when the list is a day old, or a minute old with `force`; calls already in flight are shared. */
  refresh(opts?: { force?: boolean }): Promise<ModelPricesStatus>;
  /** Fetches if due, then checks hourly. Only with pollers on. */
  start(): void;
  stop(): void;
}

export function createModelPriceService(deps: {
  /** Null keeps nothing on disk (an in-memory test board). */
  cachePath: string | null;
  fetch: FetchFn;
  /** The modelPriceFetch setting: off fetches nothing and uses no fetched price. */
  enabled: () => boolean;
  now?: () => Date;
  log?: Logger;
}): ModelPriceService {
  const now = () => (deps.now ? deps.now() : new Date()).getTime();
  const log = deps.log ?? console;
  let table: PriceTable | null = null;
  let fetchedAt: number | null = null;
  /** Fetched by this server run, with no failure since. */
  let fresh = false;
  let lastFailedAt: number | null = null;
  let loaded = false;
  let inflight: Promise<ModelPricesStatus> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const loadFromDisk = () => {
    if (loaded) return;
    loaded = true;
    if (!deps.cachePath) return;
    try {
      const file = CacheFile.parse(JSON.parse(readFileSync(deps.cachePath, "utf8")));
      const at = Date.parse(file.fetchedAt);
      const parsed = parseLiteLlmPrices(file.document);
      if (Number.isNaN(at) || parsed.entries.length === 0) return;
      table = parsed;
      fetchedAt = at;
    } catch {
      // Missing or corrupt: the next fetch replaces it, and until then the built-in table prices.
    }
  };

  const writeCache = (document: unknown, at: number) => {
    if (!deps.cachePath) return;
    const tmp = `${deps.cachePath}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(deps.cachePath), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date(at).toISOString(), document }));
      renameSync(tmp, deps.cachePath);
    } catch (error) {
      rmSync(tmp, { force: true });
      log.warn(`[model-prices] couldn't save the price list: ${messageOf(error)}`);
    }
  };

  const status = (): ModelPricesStatus => {
    loadFromDisk();
    const models = table?.entries.length ?? null;
    const failed = lastFailedAt === null ? null : new Date(lastFailedAt).toISOString();
    if (!deps.enabled()) {
      return { source: "built_in", asOf: MODEL_PRICES_AS_OF, status: "off", models, lastFailedAt: failed };
    }
    if (table && fetchedAt !== null) {
      return {
        source: "litellm",
        asOf: new Date(fetchedAt).toISOString(),
        status: fresh ? "fresh" : "cached",
        models,
        lastFailedAt: failed,
      };
    }
    return { source: "built_in", asOf: MODEL_PRICES_AS_OF, status: "unavailable", models, lastFailedAt: failed };
  };

  const fetchOne = async (url: string, accept: string): Promise<{ document: unknown; parsed: PriceTable } | null> => {
    try {
      const res = await deps.fetch(url, { headers: { accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const document: unknown = await res.json();
      const parsed = parseLiteLlmPrices(document);
      return parsed.entries.length > 0 ? { document, parsed } : null;
    } catch {
      return null;
    }
  };

  const fetchNow = async (): Promise<ModelPricesStatus> => {
    const got =
      (await fetchOne(LITELLM_PRICES_URL, "application/json")) ??
      (await fetchOne(LITELLM_PRICES_API_URL, "application/vnd.github.raw+json"));
    const at = now();
    if (!got) {
      lastFailedAt = at;
      fresh = false;
      log.warn("[model-prices] couldn't fetch LiteLLM's price list; using the last one kept, or the built-in table");
      return status();
    }
    table = got.parsed;
    fetchedAt = at;
    fresh = true;
    lastFailedAt = null;
    writeCache(got.document, at);
    return status();
  };

  const refresh: ModelPriceService["refresh"] = (opts = {}) => {
    loadFromDisk();
    if (!deps.enabled()) return Promise.resolve(status());
    if (inflight) return inflight;
    const t = now();
    const maxAge = opts.force ? PRICES_FLOOR_MS : PRICES_TTL_MS;
    if (fetchedAt !== null && t - fetchedAt < maxAge) return Promise.resolve(status());
    if (lastFailedAt !== null && t - lastFailedAt < PRICES_FLOOR_MS) return Promise.resolve(status());
    inflight = fetchNow().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  return {
    current() {
      const s = status();
      return {
        table: s.source === "litellm" ? table : null,
        source: { source: s.source, asOf: s.asOf, status: s.status },
      };
    },
    status,
    refresh,
    start() {
      if (timer) return;
      const tick = () => void refresh().catch(() => undefined);
      tick();
      timer = setInterval(tick, CHECK_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
