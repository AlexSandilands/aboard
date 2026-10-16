import { NotificationKind } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { handle, idParam, parseQuery } from "../respond.ts";

/** /api/notifications: the attention inbox. REST only: agents have no use for the user's inbox. */
export function registerNotificationRoutes(app: Hono, { services }: AppContext): void {
  const { notifications } = services;

  app.get(
    "/api/notifications",
    handle((c) => {
      const { kind, limit } = parseQuery(
        c,
        z.object({ kind: NotificationKind.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
      );
      return c.json(notifications.list({ ...(kind ? { kind } : {}), ...(limit ? { limit } : {}) }));
    }),
  );
  // Registered before /:id/read so "read-all" isn't taken for an id.
  app.post(
    "/api/notifications/read-all",
    handle((c) => {
      notifications.markAllRead();
      return c.json(notifications.list());
    }),
  );
  app.post(
    "/api/notifications/:id/read",
    handle((c) => c.json(notifications.markRead(idParam(c)))),
  );
}
