import type { Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { actorOf, handle, idParam } from "../respond.ts";

/**
 * /api/suggestions: agents' suggested changes to prompts and skills, for the user to accept or reject. Agents make
 * them over MCP (suggest_change); deciding is the user's, so there is no MCP tool for it.
 */
export function registerSuggestionRoutes(app: Hono, { services }: AppContext): void {
  const { suggestions } = services;

  app.get(
    "/api/suggestions",
    handle((c) => c.json(suggestions.list())),
  );
  app.post(
    "/api/suggestions/:id/accept",
    handle((c) => c.json(suggestions.accept(idParam(c), actorOf(c)))),
  );
  app.post(
    "/api/suggestions/:id/reject",
    handle((c) => c.json(suggestions.reject(idParam(c), actorOf(c)))),
  );
}
