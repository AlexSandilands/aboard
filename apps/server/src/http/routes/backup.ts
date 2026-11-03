import { BackupSource, BoardDump, RestoreBoardInput, RestoreTasksInput } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { actorOf, handle, parseBody, parseQuery } from "../respond.ts";

const RestoreTaskBody = z.object({
  dump: BoardDump,
  number: z.number().int().positive(),
  force: z.boolean().optional(),
  /** The backup folder the dump was read from (the CLI runs on this machine), for the task's pasted images. */
  attachmentsFrom: z.string().nullable().optional(),
});

/**
 * Git backup status, the repo's machine folders, "Back up now", putting one task back from a backup (the CLI's
 * restore-task), and restoring from the backup repo's commits (Settings → Board → Data → Restore).
 */
export function registerBackupRoutes(app: Hono, { services, integrations }: AppContext): void {
  app.get(
    "/api/backup/status",
    handle((c) => c.json(integrations.backupStatus())),
  );
  app.get(
    "/api/backup/machines",
    handle(async (c) => c.json(await integrations.backupMachines())),
  );
  app.post(
    "/api/backup/run",
    handle(async (c) => c.json(await integrations.runBackup())),
  );
  app.get(
    "/api/backup/history",
    handle(async (c) => c.json(await integrations.backupHistory(c.req.query("machine") || undefined))),
  );
  app.get(
    "/api/backup/diff",
    handle(async (c) => c.json(await integrations.backupDiff(parseQuery(c, BackupSource)))),
  );
  app.post(
    "/api/backup/restore-tasks",
    handle(async (c) =>
      c.json(await integrations.restoreBackupTasks(await parseBody(c, RestoreTasksInput), actorOf(c))),
    ),
  );
  app.post(
    "/api/backup/restore-board",
    handle(async (c) => c.json(await integrations.restoreBackupBoard(await parseBody(c, RestoreBoardInput)))),
  );
  app.post(
    "/api/backup/restore-task",
    handle(async (c) => {
      const { dump, number, force, attachmentsFrom } = await parseBody(c, RestoreTaskBody);
      return c.json(
        services.backup.restoreTask(dump, number, { force: force ?? false, actor: actorOf(c), attachmentsFrom }),
      );
    }),
  );
}
