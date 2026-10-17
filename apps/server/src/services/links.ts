import {
  agentSessionUrl,
  classifyLink,
  nextPrChanges,
  t3DesktopThreadUrl,
  type ClassifiedLink,
  type LinkInput,
  type PrSnapshot,
  type T3ThreadSnapshot,
  type TaskLink,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { nowIso, parseJson } from "../db/database.ts";
import { toLink, type LinkRow } from "../db/repos/links.ts";
import type { TaskRecord } from "../db/repos/tasks.ts";
import { AppError, notFound } from "../errors.ts";
import type { Core } from "./core.ts";
import type { NotificationsService } from "./notifications.ts";
import type { LinksService, SettingsService, TasksService } from "./types.ts";

/** Resolves link input to a kind, canonical url and ref. */
export function classifyLinkInput(input: LinkInput, jiraBaseUrl: string | null): ClassifiedLink {
  if (input.t3Thread) {
    return { kind: "t3_thread", url: t3DesktopThreadUrl(input.t3Thread), ref: input.t3Thread };
  }
  if (input.agentSession) {
    const ref = { ...input.agentSession, sessionId: input.agentSession.sessionId.toLowerCase() };
    return { kind: "agent_session", url: agentSessionUrl(ref), ref };
  }
  const value = input.value?.trim();
  if (!value) {
    throw new AppError("VALIDATION", "Provide a link value (URL or Jira key), a t3Thread or an agentSession");
  }
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

/** A session's window is stored beside its ref (see toLink), so relinking it keeps the window. */
const refJson = (c: ClassifiedLink, window?: string | null): string | null => {
  switch (c.kind) {
    case "pr":
      return c.ref ? JSON.stringify(c.ref) : null;
    case "jira":
      return JSON.stringify({ key: c.key });
    case "t3_thread":
    case "issue":
      return JSON.stringify(c.ref);
    case "agent_session":
      return JSON.stringify(window ? { ...c.ref, window } : c.ref);
    case "url":
      return null;
  }
};

/** Actor recorded when merged pull requests move a task to Done. */
export const GITHUB_ACTOR = "github";

type PolledPr = Extract<TaskLink, { kind: "pr" }> & { ref: NonNullable<Extract<TaskLink, { kind: "pr" }>["ref"]> };

const isFinished = (state: PrSnapshot["state"] | null | undefined): boolean => state === "merged" || state === "closed";

/**
 * A task's polled PRs. Links without a ref, or on a host that isn't polled (not GitHub, or `gh` isn't
 * signed in to it), are never fetched, so they can't hold a task back. One fetched before still counts,
 * so a sign-in check that fails for a moment can't let its open PR be skipped.
 */
const polledPrs = (links: readonly TaskLink[], polls: (host: string) => boolean): PolledPr[] =>
  links.filter((l): l is PolledPr => l.kind === "pr" && l.ref !== null && (l.snapshot !== null || polls(l.ref.host)));

/**
 * True when a task's pull requests are done with: every polled PR is merged or closed, and at least one merged.
 * A PR not fetched yet counts as unfinished, so one merge can't finish a task whose other PR is still open.
 */
export function prsCompleteTask(links: readonly TaskLink[], polls: (host: string) => boolean): boolean {
  const prs = polledPrs(links, polls);
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
  deps: {
    task: (id: string) => TaskRecord;
    tasks: Pick<TasksService, "move">;
    settings: SettingsService;
    notifications: NotificationsService;
    polls: (host: string) => boolean;
  },
): LinksModule {
  const { repos } = core;

  /** `creditLinkId` names the PR recorded as the merge, when it is one of the merged ones. */
  const completeIfPrsDone = (taskId: string, creditLinkId?: string): void => {
    const task = deps.task(taskId);
    // An epic's status follows its children, so its own PRs don't move it.
    if (task.status !== "review" || task.archivedAt !== null || task.kind === "epic") return;
    const links = repos.links.forTasks([task.id]).map(toLink);
    if (!prsCompleteTask(links, deps.polls)) return;
    const merged = polledPrs(links, deps.polls).filter((l) => l.snapshot?.state === "merged");
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

  /**
   * Tells the inbox about a poll that moved a link into a state that needs the user. Only a change counts: a link
   * seen for the first time (no snapshot before) was already in whatever state it is in when it was linked.
   */
  const notifyOnChange = (row: LinkRow, before: string | null, after: string | null): void => {
    const was = parseJson<PrSnapshot | T3ThreadSnapshot>(before);
    const now = parseJson<PrSnapshot | T3ThreadSnapshot>(after);
    if (!was || !now) return;
    const task = deps.task(row.task_id);
    const taskLabel = `#${task.number} ${task.title}`;
    if (row.kind === "pr") {
      const prev = was as PrSnapshot;
      const next = now as PrSnapshot;
      if (next.state !== "open" && next.state !== "draft") return;
      const ref = parseJson<{ number: number }>(row.ref_json);
      const label = ref ? `PR #${ref.number}` : "PR";
      if (next.checks === "failing" && (prev.checks !== "failing" || prev.headOid !== next.headOid)) {
        deps.notifications.notify({
          kind: "pr_checks_failing",
          taskId: task.id,
          title: `Checks failing on ${label}`,
          body: taskLabel,
          dedupeKey: `checks:${row.id}:${next.headOid ?? next.updatedAt ?? ""}`,
        });
      }
      if (next.reviewDecision === "changes_requested" && prev.reviewDecision !== "changes_requested") {
        deps.notifications.notify({
          kind: "pr_changes_requested",
          taskId: task.id,
          title: `Changes requested on ${label}`,
          body: taskLabel,
          dedupeKey: `changes:${row.id}:${next.updatedAt ?? ""}`,
        });
      }
    } else if (row.kind === "t3_thread") {
      const prev = was as T3ThreadSnapshot;
      const next = now as T3ThreadSnapshot;
      const waiting = (s: T3ThreadSnapshot) => s.status === "input" || s.status === "approval";
      // Waiting again on the same thing counts when the thread was active in between, which a poll can miss.
      const askedAgain = prev.status === next.status && (next.lastActivityAt ?? "") > (prev.lastActivityAt ?? "");
      if (waiting(next) && !next.archived && (!waiting(prev) || prev.status !== next.status || askedAgain)) {
        deps.notifications.notify({
          kind: "thread_waiting",
          taskId: task.id,
          title: next.status === "input" ? "Thread waiting for input" : "Thread waiting for approval",
          body: `${taskLabel}\n${next.title}`,
          dedupeKey: `thread:${row.id}:${next.status}:${next.lastActivityAt ?? ""}`,
        });
      }
    }
  };

  const rowOrThrow = (id: string): LinkRow => {
    const row = repos.links.row(id);
    if (!row) throw notFound("Link", id);
    return row;
  };

  const service: LinksService = {
    threadsLinked: (taskId) => repos.events.linksAdded(taskId, "t3_thread"),

    add(taskId, input, actor, opts = {}) {
      return core.write((fx) => {
        const task = deps.task(taskId);
        const classified = classifyLinkInput(input, deps.settings.get().jiraBaseUrl);
        const existing =
          repos.links.find(task.id, classified.kind, classified.url) ??
          // A Jira issue is one link however it was written: a bare key, or a URL on any host.
          (classified.kind === "jira"
            ? repos.links
                .forTasks([task.id])
                .find((l) => l.kind === "jira" && parseJson<{ key: string }>(l.ref_json)?.key === classified.key)
            : undefined);
        if (existing) {
          // A session is one link however often it is linked, but an agent may correct the folder it gave (Claude
          // finds a conversation to resume by its folder) or rename the session as its work changes (planning, then
          // implementing): the newest one wins.
          if (classified.kind === "agent_session") {
            const stored = parseJson<{ cwd?: string; window?: string }>(existing.ref_json);
            const before = stored?.cwd;
            const relabel = input.label && input.label !== existing.label ? input.label : null;
            if (before !== classified.ref.cwd || relabel) {
              if (before !== classified.ref.cwd) {
                repos.links.setRef(existing.id, refJson(classified, opts.window ?? stored?.window)!);
              }
              if (relabel) repos.links.setLabel(existing.id, relabel);
              fx.log(task.id, actor, "link_updated", {
                linkId: existing.id,
                kind: existing.kind,
                ...(before !== classified.ref.cwd ? { from: before, to: classified.ref.cwd } : {}),
                ...(relabel ? { label: relabel } : {}),
              });
              fx.task(task.id);
              return toLink(repos.links.row(existing.id)!);
            }
          }
          return toLink(existing);
        }
        const row: LinkRow = {
          id: randomUUID(),
          task_id: task.id,
          kind: classified.kind,
          url: classified.url,
          label: input.label ?? null,
          ref_json: refJson(classified, opts.window),
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

    prChanges: (linkIds) => repos.links.prChanges(linkIds),

    setWindow(linkId, window) {
      core.write((fx) => {
        const row = rowOrThrow(linkId);
        if (row.kind !== "agent_session") throw new AppError("VALIDATION", "Only agent sessions have a window");
        const { window: before, ...ref } = parseJson<{ window?: string }>(row.ref_json) ?? {};
        if ((before ?? null) === window) return;
        repos.links.setRef(linkId, JSON.stringify(window ? { ...ref, window } : ref));
        fx.task(row.task_id);
      });
    },

    setSnapshot(linkId, snapshot) {
      core.write((fx) => {
        const row = rowOrThrow(linkId);
        const json = snapshot ? JSON.stringify(snapshot) : null;
        const at = nowIso();
        repos.links.setSnapshot(linkId, json, at);
        if (json === row.snapshot_json) return;
        if (row.kind === "pr") {
          const before = repos.links.prChanges([linkId]).get(linkId) ?? {};
          const after = nextPrChanges(
            parseJson<PrSnapshot>(row.snapshot_json),
            snapshot as PrSnapshot | null,
            before,
            at,
          );
          if (JSON.stringify(after) !== JSON.stringify(before)) repos.links.setPrChanges(linkId, after);
        }
        fx.task(row.task_id);
        notifyOnChange(row, row.snapshot_json, json);
        if (row.kind === "pr") completeOnMerge({ ...row, snapshot_json: json }, row.snapshot_json);
      });
    },
  };

  return { service, completeIfPrsDone };
}
