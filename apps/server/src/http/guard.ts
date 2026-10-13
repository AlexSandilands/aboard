import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostname(hostHeader: string): string {
  return hostHeader.replace(/:\d+$/, "").toLowerCase();
}

/** The Vite dev server's port; it proxies browser requests here with its own Origin. */
const DEV_WEB_PORT = 5317;

/** True for a localhost origin served by this server or the Vite dev server. */
function isAllowedOrigin(origin: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !LOCAL_HOSTS.has(`[${host}]`)) return false;
  const originPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return originPort === port || originPort === DEV_WEB_PORT;
}

/**
 * Localhost guard: rejects non-local Host headers (DNS rebinding) and browser requests from
 * any origin other than this server or the Vite dev server, and enforces the optional bearer
 * token on /api, /mcp and /events.
 */
export function localGuard(config: Pick<Config, "token" | "port">): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host");
    if (host && !LOCAL_HOSTS.has(hostname(host))) {
      return c.json({ error: { code: "VALIDATION", message: "Forbidden host" } }, 403);
    }
    const origin = c.req.header("origin");
    if (origin && !isAllowedOrigin(origin, config.port)) {
      return c.json({ error: { code: "VALIDATION", message: "Forbidden origin" } }, 403);
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
