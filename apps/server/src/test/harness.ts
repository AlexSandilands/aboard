import { createApp } from "../app.ts";
import { createContext } from "../context.ts";
import type { BoardEvent } from "@repo/contracts";

/** In-memory server context + app for tests. `events` collects everything published on the bus. */
export function createTestHarness(overrides: { webPort?: number } = {}) {
  const ctx = createContext({
    dbPath: ":memory:",
    port: 4317,
    webPort: 5317,
    token: null,
    t3Home: "/nonexistent",
    pollers: false,
    userHome: "/nonexistent",
    ...overrides,
  });
  const app = createApp(ctx);
  const events: BoardEvent[] = [];
  ctx.bus.subscribe((e) => events.push(e));
  const request = (path: string, init?: RequestInit & { json?: unknown }) => {
    const { json, ...rest } = init ?? {};
    const headers = new Headers(rest.headers);
    if (!headers.has("host")) headers.set("host", "127.0.0.1:4317");
    if (json !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return app.request(path, {
      ...rest,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  };
  return { ...ctx, app, events, request };
}
