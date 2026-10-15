import type { Db } from "../database.ts";
import { createEventsRepo } from "./events.ts";
import { createLabelsRepo } from "./labels.ts";
import { createLinksRepo } from "./links.ts";
import { createPlansRepo } from "./plans.ts";
import { createProjectsRepo } from "./projects.ts";
import { createReviewsRepo } from "./reviews.ts";
import { createSettingsRepo } from "./settings.ts";
import { createSql } from "./sql.ts";
import { createTasksRepo } from "./tasks.ts";

/** All table repositories over one database. */
export function createRepos(db: Db) {
  const sql = createSql(db);
  return {
    projects: createProjectsRepo(sql),
    tasks: createTasksRepo(sql),
    plans: createPlansRepo(sql),
    links: createLinksRepo(sql),
    events: createEventsRepo(sql),
    labels: createLabelsRepo(sql),
    reviews: createReviewsRepo(sql),
    settings: createSettingsRepo(sql),
  };
}
export type Repos = ReturnType<typeof createRepos>;
