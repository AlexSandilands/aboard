import {
  LABEL_MAX_LENGTH,
  LABELS_PER_TASK_MAX,
  normalizeLabel,
  parseIssueSource,
  type IssueSource,
} from "@repo/contracts";
import { nowIso } from "../db/database.ts";
import type { ImportRecord } from "../db/repos/imports.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
import type { ImportResult, ImportsService, TasksService } from "./types.ts";

/** Actor recorded for what the background import changes. */
export const IMPORT_ACTOR = "import";

/** The longest title and description an import writes; a model asked for a summary shouldn't need more. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
/** A model explaining a refusal can run long; the card and panel need the gist. */
const ERROR_MAX = 400;

export interface ImportsModule {
  service: ImportsService;
  /** Inside an open write: records that the task was created from `source` and is waiting for its details. */
  beginIn(taskId: string, source: IssueSource, sourceUrl: string, fx: Effects): void;
}

/** Normalised, deduped labels from model output; labels that don't survive normalising are dropped, not errors. */
export function importLabels(raw: readonly string[], existing: readonly string[] = []): string[] {
  const labels = [...existing];
  for (const value of raw) {
    const label = normalizeLabel(value);
    if (label && label.length <= LABEL_MAX_LENGTH && !labels.includes(label)) labels.push(label);
  }
  return labels.slice(0, LABELS_PER_TASK_MAX);
}

/** Tasks created from a Jira or GitHub issue: the state of filling in their details in the background. */
export function createImportsService(core: Core, deps: { tasks: () => TasksService }): ImportsModule {
  const { repos } = core;

  const recordOf = (taskId: string): ImportRecord => {
    const record = repos.imports.get(taskId);
    if (!record) throw notFound("Import", taskId);
    return record;
  };

  const service: ImportsService = {
    get: (taskId) => repos.imports.get(taskId),

    pending: () => repos.imports.withStatus("pending"),

    claim(taskId) {
      return core.write((fx) => {
        const record = repos.imports.get(taskId);
        if (record?.status !== "pending") return null;
        const next = { ...record, attempts: record.attempts + 1, updatedAt: nowIso() };
        repos.imports.update(next);
        fx.detail(taskId);
        return next;
      });
    },

    complete(taskId, result: ImportResult) {
      core.write((fx) => {
        const record = recordOf(taskId);
        const task = deps.tasks().detail(taskId);
        const source = parseIssueSource(record.sourceUrl);
        // The user may have renamed or described the placeholder while the fetch ran; their words stand.
        const title = result.title.trim().slice(0, TITLE_MAX);
        const description = result.description?.trim().slice(0, DESCRIPTION_MAX);
        deps.tasks().update(
          taskId,
          {
            ...(title && task.title === source?.placeholder ? { title } : {}),
            ...(description && !task.description?.trim() ? { description } : {}),
            labels: importLabels(result.labels, task.labels),
          },
          IMPORT_ACTOR,
        );
        repos.imports.update({ ...record, status: "done", error: null, updatedAt: nowIso() });
        fx.log(taskId, IMPORT_ACTOR, "imported", { source: record.sourceUrl });
      });
    },

    fail(taskId, message) {
      const error = message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX - 1)}…` : message;
      core.write((fx) => {
        const record = recordOf(taskId);
        repos.imports.update({ ...record, status: "failed", error, updatedAt: nowIso() });
        fx.log(taskId, IMPORT_ACTOR, "import_failed", { source: record.sourceUrl, error });
      });
    },

    retry(taskId, actor) {
      core.write((fx) => {
        const record = recordOf(taskId);
        if (record.status !== "failed") {
          throw new AppError("CONFLICT", `Only a failed import can be retried; this one is ${record.status}`);
        }
        repos.imports.update({ ...record, status: "pending", error: null, attempts: 0, updatedAt: nowIso() });
        fx.log(taskId, actor, "import_retried", { source: record.sourceUrl });
      });
    },
  };

  return {
    service,
    beginIn(taskId, source, sourceUrl, fx) {
      const now = nowIso();
      repos.imports.insert({
        taskId,
        sourceUrl,
        sourceKind: source.kind,
        status: "pending",
        error: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      fx.task(taskId);
    },
  };
}
