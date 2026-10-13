import type { Hono } from "hono";
import type { AppContext } from "../app.ts";

/** Mounts the MCP endpoint at /mcp. Implemented by the MCP work package. */
export function registerMcp(_app: Hono, _ctx: AppContext): void {}
