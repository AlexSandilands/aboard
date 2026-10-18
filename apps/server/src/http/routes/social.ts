import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { handle } from "../respond.ts";

/** /api/social: the user's read-only feed of the agents' social network. Agents post and read over MCP. */
export function registerSocialRoutes(app: Hono, { services }: AppContext): void {
  app.get(
    "/api/social",
    handle((c) => c.json(services.social.feed())),
  );
}
