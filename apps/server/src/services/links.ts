import { classifyLink, t3DesktopThreadUrl, type ClassifiedLink, type LinkInput, type TaskLink } from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso } from "../db/database.ts";
import { toLink, type LinkRow } from "../db/repos/links.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { LinksService, SettingsService } from "./types.ts";

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

/** Task links (PRs, Jira, T3 threads, URLs) and their poller snapshots. */
export function createLinksService(
  core: Core,
  deps: { task: (id: string) => TaskRecord; settings: SettingsService },
): LinksService {
  const { repos } = core;

  const rowOrThrow = (id: string): LinkRow => {
    const row = repos.links.row(id);
    if (!row) throw notFound("Link", id);
    return row;
  };

  return {
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
        if (json !== row.snapshot_json) fx.task(row.task_id);
      });
    },
  };
}
