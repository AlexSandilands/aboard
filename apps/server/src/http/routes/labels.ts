import { SetLabelColorInput } from "@repo/contracts";
import type { Context, Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { handle, parseBody } from "../respond.ts";

const nameParam = (c: Context): string => c.req.param("name") ?? "";

/** /api/labels: labels in use and their colour overrides. */
export function registerLabelRoutes(app: Hono, { services }: AppContext): void {
  app.get(
    "/api/labels",
    handle((c) => c.json(services.labels.usage())),
  );
  app.put(
    "/api/labels/:name/color",
    handle(async (c) => {
      const { hue } = await parseBody(c, SetLabelColorInput);
      return c.json(services.labels.setColor(nameParam(c), hue));
    }),
  );
  app.delete(
    "/api/labels/:name/color",
    handle((c) => c.json(services.labels.clearColor(nameParam(c)))),
  );
}
