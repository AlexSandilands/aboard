import { BoardDump, CheckBackupRemoteInput, CreateBackupRepoInput } from "@repo/contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../app.ts";
import { actorOf, handle, parseBody } from "../respond.ts";

const RestoreTaskBody = z.object({
  dump: BoardDump,
  number: z.number().int().positive(),
  force: z.boolean().optional(),
  /** The backup folder the dump was read from (the CLI runs on this machine), for the task's pasted images. */
  attachmentsFrom: z.string().nullable().optional(),
});

/** Git backup status, the repo's machine folders, "Back up now", the guided setup, and putting one task back from a backup (the CLI's restore-task). */
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
    "/api/backup/setup-info",
    handle(async (c) => c.json(await integrations.backupSetupInfo())),
  );
  app.post(
    "/api/backup/github-repo",
    handle(async (c) => {
      const { name } = await parseBody(c, CreateBackupRepoInput);
      return c.json(await integrations.createBackupRepo(name));
    }),
  );
  app.post(
    "/api/backup/check-remote",
    handle(async (c) => {
      const { remote } = await parseBody(c, CheckBackupRemoteInput);
      return c.json(await integrations.checkBackupRemote(remote));
    }),
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
