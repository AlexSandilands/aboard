import type { T3IntegrationStatus } from "@repo/contracts";
import type { EventBus } from "../bus.ts";
import type { Db } from "../db/database.ts";
import { createRepos } from "../db/repos/index.ts";
import { AUTOMATIONS } from "../autopilot/automations/index.ts";
import type { Automation } from "../autopilot/types.ts";
import { createAutopilotService } from "./autopilot.ts";
import { createBackupService } from "./backup/index.ts";
import { createBoardService } from "./board.ts";
import { createCore } from "./core.ts";
import { createImportsService, type ImportsModule } from "./imports.ts";
import { createLabelsService } from "./labels.ts";
import { createLinksService, type LinksModule } from "./links.ts";
import { createPlans, type PlansModule } from "./plans.ts";
import { createProjectsService } from "./projects.ts";
import { createRelations, type RelationsModule } from "./relations.ts";
import { createRecurringService } from "./recurring.ts";
import { createReviewsService } from "./reviews.ts";
import { createSettingsService } from "./settings.ts";
import { createTemplatesService } from "./templates.ts";
import { createTasksService } from "./tasks.ts";
import type { ReviewsService, Services } from "./types.ts";

export interface ServiceDeps {
  db: Db;
  bus: EventBus;
  /** Current T3 integration status, embedded in board snapshots. */
  t3Status: () => T3IntegrationStatus;
  /** Whether an unfinished PR on a host keeps a Review task from Done. Defaults to github.com only. */
  prHostHoldsTasks?: (host: string) => boolean;
  /** The Autopilot catalogue; tests swap in their own. */
  automations?: readonly Automation[];
}

/** Builds the service layer over one database. */
export function createServices(deps: ServiceDeps): Services {
  const core = createCore({ ...deps, repos: createRepos(deps.db) });
  const settings = createSettingsService(core);
  const projects = createProjectsService(core);
  const labels = createLabelsService(core);
  const templates = createTemplatesService(core, { projects });

  let plans: PlansModule | null = null;
  let links: LinksModule | null = null;
  let reviews: ReviewsService | null = null;
  let imports: ImportsModule | null = null;
  let relations: RelationsModule | null = null;
  const tasks = createTasksService(core, {
    projects,
    plans: () => plans!,
    links: () => links!,
    reviews: () => reviews!,
    labels,
    settings,
    imports: () => imports!,
    templates,
    relations: () => relations!,
  });
  relations = createRelations(core, { resolveId: (ref) => tasks.service.resolveId(ref), record: tasks.record });
  imports = createImportsService(core, { tasks: () => tasks.service });
  plans = createPlans(core, { task: tasks.record, detail: (id) => tasks.service.detail(id) });
  links = createLinksService(core, {
    task: tasks.record,
    tasks: tasks.service,
    settings,
    polls: deps.prHostHoldsTasks ?? ((host) => host === "github.com"),
  });
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
    imports: imports.service,
    backup: createBackupService(core),
    templates,
    autopilot: createAutopilotService(core, { automations: deps.automations ?? AUTOMATIONS }),
    recurring: createRecurringService(core, { projects, templates }),
  };
}
