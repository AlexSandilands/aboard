import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "./bus.ts";

/** GET /events — streams every BoardEvent as an SSE `message` with a JSON body. */
export function registerSse(app: Hono, bus: EventBus): void {
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = bus.subscribe((event) => {
        queue.push(JSON.stringify(event));
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        if (queue.length === 0) {
          // Heartbeat keeps proxies and the browser from timing out idle streams.
          await Promise.race([
            new Promise<void>((resolve) => (wake = resolve)),
            new Promise<void>((resolve) => setTimeout(resolve, 25_000)),
          ]);
          wake = null;
          if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
          continue;
        }
        const data = queue.shift()!;
        await stream.writeSSE({ data });
      }
      unsubscribe();
    }),
  );
}
