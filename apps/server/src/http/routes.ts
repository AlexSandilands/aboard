import type { Hono } from "hono";
import type { AppContext } from "../app.ts";

/** Registers all /api routes. Implemented by the server-core work package. */
export function registerApiRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/board", (c) => c.json(ctx.services.board.snapshot()));
}
