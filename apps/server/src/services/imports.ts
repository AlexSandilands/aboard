import {
  LABEL_MAX_LENGTH,
  LABELS_PER_TASK_MAX,
  normalizeLabel,
  parseIssueSource,
  type IssueSource,
} from "@repo/contracts";
import { nowIso } from "../db/database.ts";
import type { ImportRecord } from "../db/repos/imports.ts";
import { toLink } from "../db/repos/links.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core, Effects } from "./core.ts";
import type { ImportCompletion, ImportResult, ImportsService, SettingsService, TasksService } from "./types.ts";

/** Actor recorded for what the background import changes. */
export const IMPORT_ACTOR = "import";

/** The longest title and description an import writes; a model asked for a summary shouldn't need more. */
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 20_000;
/** A model explaining a refusal can run long; the card and panel need the gist. */
const ERROR_MAX = 400;
/** The most children of an epic an import turns into tasks; the epic's note says how many more there are. */
export const IMPORT_CHILDREN_MAX = 50;

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

/** One name per issue, however it was written: a Jira key, or a GitHub issue's host, repo and number. */
function issueIdentity(source: IssueSource): string {
  return source.kind === "jira"
    ? `jira:${source.key.toUpperCase()}`
    : `issue:${source.ref.host}/${source.ref.repo}#${source.ref.number}`.toLowerCase();
}

/** Tasks created from a Jira or GitHub issue: the state of filling in their details in the background. */
export function createImportsService(
  core: Core,
  deps: { tasks: () => TasksService; settings: SettingsService },
): ImportsModule {
  const { repos } = core;

  /** Unarchived tasks in the project linked to each issue, by issueIdentity. */
  const linkedTasks = (projectId: string): Map<string, string[]> => {
    const byIssue = new Map<string, string[]>();
    const links = [...repos.links.byKindActive("jira"), ...repos.links.byKindActive("issue")].map(toLink);
    const inProject = new Set(
      repos.tasks
        .getMany([...new Set(links.map((l) => l.taskId))])
        .filter((t) => t.projectId === projectId)
        .map((t) => t.id),
    );
    for (const link of links) {
      if (!inProject.has(link.taskId)) continue;
      const id =
        link.kind === "jira"
          ? `jira:${link.ref.key.toUpperCase()}`
          : link.kind === "issue"
            ? `issue:${link.ref.host}/${link.ref.repo}#${link.ref.number}`.toLowerCase()
            : null;
      if (!id) continue;
      const ids = byIssue.get(id) ?? [];
      if (!ids.includes(link.taskId)) byIssue.set(id, [...ids, link.taskId]);
    }
    return byIssue;
  };

  /**
   * Inside the import's write: turns the task into an epic and fills it with the issue's children. A child already on
   * the board in the project (linked to the same issue, not archived) joins the epic rather than being created twice;
   * one in another epic is left there. Returns the tasks created, whose imports the caller starts.
   */
  const fillEpic = (
    taskId: string,
    sourceLabel: string,
    sourceKind: IssueSource["kind"],
    epic: NonNullable<ImportResult["epic"]>,
  ): string[] => {
    const tasks = deps.tasks();
    // An empty epic and one whose children couldn't be listed (no Jira search tool allowed, or a search that failed)
    // look the same, so it stays a task rather than becoming an empty epic nobody would notice.
    if (epic.children.length === 0 && repos.tasks.get(taskId)?.parentId === null) {
      tasks.addNote(
        taskId,
        `${sourceLabel} is an epic, but none of its child issues could be listed, so it was imported as a task. If it has some, check that a Jira search tool is allowed in Settings → Tasks → New tasks → Jira tools, then paste it again.`,
        IMPORT_ACTOR,
      );
      return [];
    }
    const unable = tasks.makeEpic(taskId, IMPORT_ACTOR);
    if (unable) {
      tasks.addNote(
        taskId,
        `${sourceLabel} is an epic with ${epic.total} ${epic.total === 1 ? "task" : "tasks"}, but this task can't become an epic: ${unable}. Its tasks weren't imported.`,
        IMPORT_ACTOR,
      );
      return [];
    }
    const self = repos.tasks.get(taskId)!;
    const settings = deps.settings.get();
    const existing = linkedTasks(self.projectId);
    const seen = new Set<string>();
    const created: string[] = [];
    const joined: number[] = [];
    const elsewhere: string[] = [];
    let unreadable = 0;
    for (const child of epic.children) {
      if (seen.size >= IMPORT_CHILDREN_MAX) break;
      // Jira children come from the model, which has just read text anyone could write: anything but a Jira issue
      // (a GitHub URL, say, which would be read with the user's gh) is dropped rather than trusted. A child is always
      // the same kind of issue as its epic.
      const source = parseIssueSource(child, settings);
      if (source?.kind !== sourceKind) {
        unreadable++;
        continue;
      }
      const id = issueIdentity(source);
      if (seen.has(id)) continue;
      seen.add(id);
      const matches = (existing.get(id) ?? []).filter((t) => t !== taskId).map((t) => repos.tasks.get(t)!);
      if (matches.some((t) => t.parentId === taskId)) continue;
      const loose = matches.find((t) => t.kind === "task" && t.parentId === null);
      if (loose) {
        tasks.update(loose.id, { epicId: taskId }, IMPORT_ACTOR);
        joined.push(loose.number);
        continue;
      }
      const other = matches[0];
      if (other) {
        const where =
          other.kind === "epic" ? "is an epic" : `is in epic #${repos.tasks.get(other.parentId!)?.number ?? "?"}`;
        elsewhere.push(`${source.placeholder} (#${other.number} ${where})`);
        continue;
      }
      created.push(
        tasks.create({ projectId: self.projectId, sourceUrl: child, epicId: taskId, actor: IMPORT_ACTOR }).id,
      );
    }
    const lines: string[] = [];
    if (joined.length) {
      lines.push(`Already on the board, so moved into this epic: ${joined.map((n) => `#${n}`).join(", ")}.`);
    }
    if (elsewhere.length) lines.push(`Left where they are, not added: ${elsewhere.join(", ")}.`);
    if (epic.total > IMPORT_CHILDREN_MAX) {
      lines.push(
        `${sourceLabel} has ${epic.total} tasks; only the first ${IMPORT_CHILDREN_MAX} were imported. Add the rest by pasting their keys or URLs.`,
      );
    }
    if (unreadable) {
      lines.push(
        `Skipped ${unreadable === 1 ? "a child issue that wasn't" : `${unreadable} child issues that weren't`} ${sourceKind === "jira" ? "a Jira issue" : "a GitHub issue"}.`,
      );
    }
    if (lines.length) tasks.addNote(taskId, lines.join("\n\n"), IMPORT_ACTOR);
    return created;
  };

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

    complete(taskId, result: ImportResult): ImportCompletion {
      return core.write((fx) => {
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
        const childImports = result.epic
          ? fillEpic(taskId, source?.placeholder ?? record.sourceUrl, record.sourceKind, result.epic)
          : [];
        repos.imports.update({ ...record, status: "done", error: null, updatedAt: nowIso() });
        fx.log(taskId, IMPORT_ACTOR, "imported", { source: record.sourceUrl });
        return { childImports };
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
        // A pending one may be stuck (its task was archived at a restart, say) or running, which a retry leaves alone.
        if (record.status === "done") throw new AppError("CONFLICT", "This import already finished");
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
