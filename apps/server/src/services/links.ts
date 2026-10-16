import {
  classifyLink,
  t3DesktopThreadUrl,
  type ClassifiedLink,
  type LinkInput,
  type PrSnapshot,
  type TaskLink,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso, parseJson } from "../db/database.ts";
import { toLink, type LinkRow } from "../db/repos/links.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { LinksService, SettingsService, TasksService } from "./types.ts";

/** Resolves link input to a kind, canonical url and ref. */
export function classifyLinkInput(input: LinkInput, jiraBaseUrl: string | null): ClassifiedLink {
  if (input.t3Thread) {
    return { kind: "t3_thread", url: t3DesktopThreadUrl(input.t3Thread), ref: input.t3Thread };
  }
  const value = input.value?.trim();
  if (!value) throw new AppError("VALIDATION", "Provide a link value (URL or Jira key) or a t3Thread reference");
  const looksLikeKey = /^[a-z][a-z0-9_]+-\d+$/i.test(value);
  const classified = classifyLink(looksLikeKey ? value.toUpperCase() : value, { jiraBaseUrl });
  if (!classified) throw new AppError("VALIDATION", `Not a recognisable link: ${value}`);
  const canonical: ClassifiedLink =
    classified.kind === "t3_thread" ? { ...classified, url: t3DesktopThreadUrl(classified.ref) } : classified;
  if (!input.kind || input.kind === canonical.kind) return canonical;
  if (input.kind === "url") return { kind: "url", url: canonical.url };
  if (input.kind === "pr" && canonical.kind === "url") return { kind: "pr", url: canonical.url, ref: null };
  throw new AppError("VALIDATION", `"${value}" does not look like a ${input.kind} link`);
}

const refJson = (c: ClassifiedLink): string | null => {
  switch (c.kind) {
    case "pr":
      return c.ref ? JSON.stringify(c.ref) : null;
    case "jira":
      return JSON.stringify({ key: c.key });
    case "t3_thread":
      return JSON.stringify(c.ref);
    case "url":
      return null;
  }
};

/** Actor recorded when merged pull requests move a task to Done. */
export const GITHUB_ACTOR = "github";

type PolledPr = Extract<TaskLink, { kind: "pr" }> & { ref: NonNullable<Extract<TaskLink, { kind: "pr" }>["ref"]> };

const isFinished = (state: PrSnapshot["state"] | null | undefined): boolean => state === "merged" || state === "closed";

/** A task's polled PRs: links without a ref are never fetched, so they can't hold a task back. */
const polledPrs = (links: readonly TaskLink[]): PolledPr[] =>
  links.filter((l): l is PolledPr => l.kind === "pr" && l.ref !== null);

/**
 * True when a task's pull requests are done with: every polled PR is merged or closed, and at least one merged.
 * A PR not fetched yet counts as unfinished, so one merge can't finish a task whose other PR is still open.
 */
export function prsCompleteTask(links: readonly TaskLink[]): boolean {
  const prs = polledPrs(links);
  return prs.some((l) => l.snapshot?.state === "merged") && prs.every((l) => isFinished(l.snapshot?.state));
}

export interface LinksModule {
  service: LinksService;
  /**
   * Inside an open write: moves a Review task to Done (actor "github") when `prsCompleteTask` holds for its links.
   * The tasks service calls this when a task enters Review, so a merge seen earlier still completes it.
   */
  completeIfPrsDone(taskId: string): void;
}

/** Task links (PRs, Jira, T3 threads, URLs) and their poller snapshots. */
export function createLinksService(
  core: Core,
  deps: { task: (id: string) => TaskRecord; tasks: Pick<TasksService, "move">; settings: SettingsService },
): LinksModule {
  const { repos } = core;

  /** `creditLinkId` names the PR recorded as the merge, when it is one of the merged ones. */
  const completeIfPrsDone = (taskId: string, creditLinkId?: string): void => {
    const task = deps.task(taskId);
    // An epic's status follows its children, so its own PRs don't move it.
    if (task.status !== "review" || task.archivedAt !== null || task.kind === "epic") return;
    const links = repos.links.forTasks([task.id]).map(toLink);
    if (!prsCompleteTask(links)) return;
    const merged = polledPrs(links).filter((l) => l.snapshot?.state === "merged");
    const pr = merged.find((l) => l.id === creditLinkId) ?? merged[0]!;
    try {
      deps.tasks.move(task.id, { status: "done" }, GITHUB_ACTOR, { mergedPr: `${pr.ref.repo}#${pr.ref.number}` });
    } catch (error) {
      // move's plan check rejects a Review task whose steps were all removed; keep the snapshot rather than roll it back.
      if (error instanceof AppError && error.code === "PLAN_REQUIRED") return;
      throw error;
    }
  };

  /**
   * Moves a Review task to Done once its PRs are finished. Only runs when this PR has just become merged or
   * closed, so re-polling a merged PR never pulls back a task the user moved out of Done.
   */
  const completeOnMerge = (row: LinkRow, before: string | null): void => {
    const wasFinished = isFinished(parseJson<PrSnapshot>(before)?.state);
    if (wasFinished || !isFinished(parseJson<PrSnapshot>(row.snapshot_json)?.state)) return;
    completeIfPrsDone(row.task_id, row.id);
  };

  const rowOrThrow = (id: string): LinkRow => {
    const row = repos.links.row(id);
    if (!row) throw notFound("Link", id);
    return row;
  };

  const service: LinksService = {
    add(taskId, input, actor) {
      return core.write((fx) => {
        const task = deps.task(taskId);
        const classified = classifyLinkInput(input, deps.settings.get().jiraBaseUrl);
        const existing = repos.links.find(task.id, classified.kind, classified.url);
        if (existing) return toLink(existing);
        const row: LinkRow = {
          id: randomUUID(),
          task_id: task.id,
          kind: classified.kind,
          url: classified.url,
          label: input.label ?? null,
          ref_json: refJson(classified),
          snapshot_json: null,
          synced_at: null,
          created_at: nowIso(),
        };
        repos.links.insert(row);
        fx.log(task.id, actor, "link_added", { linkId: row.id, kind: row.kind, url: row.url });
        return toLink(row);
      });
    },

    remove(linkId, actor) {
      core.write((fx) => {
        const row = rowOrThrow(linkId);
        repos.links.delete(linkId);
        fx.log(row.task_id, actor, "link_removed", { kind: row.kind, url: row.url });
      });
    },

    get: (linkId) => toLink(rowOrThrow(linkId)),

    listByKind: (kind): TaskLink[] => repos.links.byKindActive(kind).map(toLink),

    setSnapshot(linkId, snapshot) {
      core.write((fx) => {
        const row = rowOrThrow(linkId);
        const json = snapshot ? JSON.stringify(snapshot) : null;
        repos.links.setSnapshot(linkId, json, nowIso());
        if (json === row.snapshot_json) return;
        fx.task(row.task_id);
        if (row.kind === "pr") completeOnMerge({ ...row, snapshot_json: json }, row.snapshot_json);
      });
    },
  };

  return { service, completeIfPrsDone };
}
