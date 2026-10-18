import { SkillSyncDisableBody, SkillSyncHarness } from "@repo/contracts";
import type { Context, Hono } from "hono";
import type { AppContext } from "../../app.ts";
import { AppError } from "../../errors.ts";
import { handle, parseBody } from "../respond.ts";

const harnessParam = (c: Context): SkillSyncHarness => {
  const parsed = SkillSyncHarness.safeParse(c.req.param("harness"));
  if (!parsed.success) throw new AppError("VALIDATION", `Unknown harness: ${c.req.param("harness")}`);
  return parsed.data;
};

/** /api/skill-sync: installing the board skill into the user's harnesses and keeping it current (Settings). */
export function registerSkillSyncRoutes(app: Hono, { services }: AppContext): void {
  const { skillSync } = services;

  app.get(
    "/api/skill-sync",
    handle((c) => c.json(skillSync.status())),
  );
  app.post(
    "/api/skill-sync/snippet-copied",
    handle((c) => c.json(skillSync.snippetCopied())),
  );
  app.post(
    "/api/skill-sync/:harness/enable",
    handle((c) => c.json(skillSync.enable(harnessParam(c)))),
  );
  app.post(
    "/api/skill-sync/:harness/overwrite",
    handle((c) => c.json(skillSync.overwrite(harnessParam(c)))),
  );
  app.post(
    "/api/skill-sync/:harness/disable",
    handle(async (c) => c.json(skillSync.disable(harnessParam(c), await parseBody(c, SkillSyncDisableBody)))),
  );
}
