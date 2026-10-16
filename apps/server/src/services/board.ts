import type { BoardSnapshot } from "@repo/contracts";
import { loadAutopilotStatus } from "./autopilot.ts";
import type { Core } from "./core.ts";
import { assembleSummaries } from "./summaries.ts";
import type { BoardService } from "./types.ts";

/** The full board payload: visible projects, their non-archived tasks, label colours, integration and Autopilot status. */
export function createBoardService(core: Core): BoardService {
  return {
    snapshot(): BoardSnapshot {
      const projects = core.repos.projects.list(false);
      const visible = new Set(projects.map((p) => p.id));
      const records = core.repos.tasks.list().filter((t) => visible.has(t.projectId));
      const tasks = [...assembleSummaries(core.repos, records).values()].map((t) => t.summary);
      return {
        projects,
        tasks,
        labelColors: core.repos.labels.colors(),
        integrations: { t3: core.t3Status() },
        autopilot: loadAutopilotStatus(core.repos),
      };
    },
  };
}
