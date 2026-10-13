import { createApp } from "../app.ts";
import { createContext } from "../context.ts";
import type { BoardEvent } from "@taskboard/contracts";

/** In-memory server context + app for tests. `events` collects everything published on the bus. */
export function createTestHarness() {
  const ctx = createContext({ dbPath: ":memory:", port: 4317, token: null, t3Home: "/nonexistent", pollers: false });
  const app = createApp(ctx);
  const events: BoardEvent[] = [];
  ctx.bus.subscribe((e) => events.push(e));
  const request = (path: string, init?: RequestInit & { json?: unknown }) => {
    const { json, ...rest } = init ?? {};
    return app.request(path, {
      ...rest,
      headers: { host: "127.0.0.1:4317", ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  };
  return { ...ctx, app, events, request };
}
