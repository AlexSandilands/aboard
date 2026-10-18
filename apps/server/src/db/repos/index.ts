import type { Db } from "../database.ts";
import { createAttachmentsRepo } from "./attachments.ts";
import { createAutopilotCustomRepo } from "./autopilotCustom.ts";
import { createAutopilotDigestsRepo } from "./autopilotDigests.ts";
import { createAutopilotRecurringRepo } from "./autopilotRecurring.ts";
import { createAutopilotRunsRepo } from "./autopilotRuns.ts";
import { createAutopilotSettingsRepo } from "./autopilotSettings.ts";
import { createEventsRepo } from "./events.ts";
import { createImportsRepo } from "./imports.ts";
import { createLabelsRepo } from "./labels.ts";
import { createLinksRepo } from "./links.ts";
import { createNotificationsRepo } from "./notifications.ts";
import { createPlansRepo } from "./plans.ts";
import { createProjectsRepo } from "./projects.ts";
import { createRelationsRepo } from "./relations.ts";
import { createReviewsRepo } from "./reviews.ts";
import { createSettingsRepo } from "./settings.ts";
import { createSocialRepo } from "./social.ts";
import { createSql } from "./sql.ts";
import { createTemplatesRepo } from "./templates.ts";
import { createTasksRepo } from "./tasks.ts";

/** All table repositories over one database. */
export function createRepos(db: Db) {
  const sql = createSql(db);
  return {
    projects: createProjectsRepo(sql),
    tasks: createTasksRepo(sql),
    plans: createPlansRepo(sql),
    attachments: createAttachmentsRepo(sql),
    links: createLinksRepo(sql),
    events: createEventsRepo(sql),
    imports: createImportsRepo(sql),
    labels: createLabelsRepo(sql),
    relations: createRelationsRepo(sql),
    reviews: createReviewsRepo(sql),
    settings: createSettingsRepo(sql),
    templates: createTemplatesRepo(sql),
    autopilotSettings: createAutopilotSettingsRepo(sql),
    autopilotRuns: createAutopilotRunsRepo(sql),
    autopilotRecurring: createAutopilotRecurringRepo(sql),
    autopilotCustom: createAutopilotCustomRepo(sql),
    autopilotDigests: createAutopilotDigestsRepo(sql),
    notifications: createNotificationsRepo(sql),
    social: createSocialRepo(sql),
  };
}
export type Repos = ReturnType<typeof createRepos>;
