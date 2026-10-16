import type { T3IntegrationStatus } from "@repo/contracts";
import type { EventBus } from "../bus.ts";
import type { Db } from "../db/database.ts";
import { createRepos } from "../db/repos/index.ts";
import { createBackupService } from "./backup/index.ts";
import { createBoardService } from "./board.ts";
import { createCore } from "./core.ts";
import { createLabelsService } from "./labels.ts";
import { createLinksService, type LinksModule } from "./links.ts";
import { createPlans, type PlansModule } from "./plans.ts";
import { createProjectsService } from "./projects.ts";
import { createReviewsService } from "./reviews.ts";
import { createSettingsService } from "./settings.ts";
import { createTasksService } from "./tasks.ts";
import type { ReviewsService, Services } from "./types.ts";

export interface ServiceDeps {
  db: Db;
  bus: EventBus;
  /** Current T3 integration status, embedded in board snapshots. */
  t3Status: () => T3IntegrationStatus;
}

/** Builds the service layer over one database. */
export function createServices(deps: ServiceDeps): Services {
  const core = createCore({ ...deps, repos: createRepos(deps.db) });
  const settings = createSettingsService(core);
  const projects = createProjectsService(core);
  const labels = createLabelsService(core);

  let plans: PlansModule | null = null;
  let links: LinksModule | null = null;
  let reviews: ReviewsService | null = null;
  const tasks = createTasksService(core, {
    projects,
    plans: () => plans!,
    links: () => links!,
    reviews: () => reviews!,
    labels,
  });
  plans = createPlans(core, { task: tasks.record, detail: (id) => tasks.service.detail(id) });
  links = createLinksService(core, { task: tasks.record, tasks: tasks.service, settings });
  reviews = createReviewsService(core, { task: tasks.record });

  return {
    projects,
    tasks: tasks.service,
    plans: plans.service,
    links: links.service,
    settings,
    board: createBoardService(core),
    reviews,
    labels: labels.service,
    backup: createBackupService(core),
  };
}
