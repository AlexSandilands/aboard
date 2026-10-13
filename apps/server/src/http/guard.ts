import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(hostHeader: string): string {
  return hostHeader.replace(/:\d+$/, "").toLowerCase();
}

/**
 * Localhost guard: rejects non-local Host headers (DNS rebinding) and cross-origin browser
 * requests, and enforces the optional bearer token on /api and /mcp.
 */
export function localGuard(config: Pick<Config, "token">): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host");
    if (host && !LOCAL_HOSTS.has(hostname(host))) {
      return c.json({ error: { code: "VALIDATION", message: "Forbidden host" } }, 403);
    }
    const origin = c.req.header("origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        // fall through to reject
      }
      if (!LOCAL_HOSTS.has(originHost) && !LOCAL_HOSTS.has(`[${originHost}]`)) {
        return c.json({ error: { code: "VALIDATION", message: "Forbidden origin" } }, 403);
      }
    }
    const path = c.req.path;
    if (config.token && (path.startsWith("/api/") || path === "/mcp" || path === "/events") && path !== "/api/health") {
      const auth = c.req.header("authorization");
      const queryToken = c.req.query("token");
      if (auth !== `Bearer ${config.token}` && queryToken !== config.token) {
        return c.json({ error: { code: "VALIDATION", message: "Unauthorized" } }, 401);
      }
    }
    await next();
  };
}
