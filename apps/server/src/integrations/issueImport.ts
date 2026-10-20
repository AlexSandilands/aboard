import { parseIssueSource, resolveHeadlessModel, type TaskLink } from "@repo/contracts";
import { tmpdir } from "node:os";
import type { ImportRecord } from "../db/repos/imports.ts";
import type { ImportResult, Services } from "../services/types.ts";
import { messageOf, type IssueDetails } from "./github.ts";
import {
  jiraToolRules,
  listConnectedMcpServers,
  runIssueImport,
  writeToolDenyRules,
  type RunImport,
} from "./headlessImport.ts";
import type { Logger } from "./util.ts";

/** Runs an import may start before it is given up on; each restart mid-import counts as one. */
export const MAX_IMPORT_ATTEMPTS = 3;
/** Imports running at once. */
const CONCURRENCY = 3;
const SERVERS_TTL_MS = 5 * 60_000;
/** How much of a GitHub issue's body becomes the description when no model is available to summarise it. */
const RAW_BODY_MAX = 4_000;

export interface IssueImporter {
  /** Queues the task's pending import; it runs in the background. */
  start(taskId: string): void;
  /** Queues every pending import, for after a restart. */
  resume(): void;
  /** Resolves when nothing is running or queued. */
  idle(): Promise<void>;
}

/**
 * Fills in tasks created from a ticket or a GitHub issue: reads the issue, has a small model turn it into a title,
 * description and labels, and records the result (or why it failed) on the task's import. A GitHub issue still
 * imports, as its raw title and body, when the model can't run. A ticket can only be read by the model, through the
 * user's own MCP server for its system.
 */
export function createIssueImporter(deps: {
  services: () => Services;
  github: {
    fetchIssue(ref: { host: string; repo: string; number: number }): Promise<IssueDetails>;
    fetchSubIssues(ref: { host: string; repo: string; number: number }): Promise<string[]>;
  };
  runImport?: RunImport;
  listMcpServers?: (cli: string | null, cwd: string) => Promise<string[]>;
  log?: Logger;
}): IssueImporter {
  const runImport = deps.runImport ?? runIssueImport;
  const listServers = deps.listMcpServers ?? listConnectedMcpServers;
  const log = deps.log ?? console;
  /** `claude mcp list` health-checks every server, which takes seconds; the answer is kept for a while. */
  let listing: { at: number; list: Promise<string[]> } | null = null;
  /** Why the last listing failed, to say so when no import tool turns up. */
  let listError: string | null = null;
  const queue: string[] = [];
  const running = new Set<string>();
  let idleWaiters: Array<() => void> = [];

  const notifyIdle = () => {
    if (running.size > 0 || queue.length > 0) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const issueLink = (taskId: string): Extract<TaskLink, { kind: "issue" }> | undefined =>
    deps
      .services()
      .tasks.summary(taskId)
      .links.find((l): l is Extract<TaskLink, { kind: "issue" }> => l.kind === "issue");

  const importGithub = async (record: ImportRecord): Promise<ImportResult> => {
    const s = deps.services();
    const source = parseIssueSource(record.sourceUrl, { ticketSystems: s.settings.get().ticketSystems });
    if (source?.kind !== "issue") throw new Error(`${record.sourceUrl} is not a GitHub issue`);
    const issue = await deps.github.fetchIssue(source.ref);
    const link = issueLink(record.taskId);
    if (link) s.links.setSnapshot(link.id, { state: issue.state, title: issue.title });
    // An issue with sub-issues is GitHub's epic. Without them (or when they can't be read) it is a plain task. A task
    // already in an epic (an epic's own child) can't become one, since epics don't nest, so it isn't asked.
    const inEpic = s.tasks.summary(record.taskId).parent !== null;
    const subIssues = inEpic
      ? []
      : await deps.github.fetchSubIssues(source.ref).catch((error: unknown) => {
          log.warn(`[import] ${record.sourceUrl}: couldn't read its sub-issues: ${messageOf(error)}`);
          return [];
        });
    const epic = subIssues.length > 0 ? { epic: { children: subIssues, total: subIssues.length } } : {};

    const raw = (): ImportResult => ({
      title: issue.title,
      description: issue.body.trim() ? issue.body.trim().slice(0, RAW_BODY_MAX) : null,
      labels: issue.labels,
      ...epic,
    });
    const settings = s.settings.get();
    if (!settings.issueImportEnabled) return raw();
    try {
      const outcome = await runImport({
        cli: settings.headlessReviewCli,
        cwd: tmpdir(),
        model: resolveHeadlessModel(settings.modelTiers, settings.issueImportModel),
        budgetUsd: settings.issueImportBudgetUsd,
        source: {
          kind: "issue",
          repo: source.ref.repo,
          number: source.ref.number,
          url: source.url,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
        },
        boardLabels: s.labels.usage().map((l) => l.name),
        jiraTools: [],
        denyTools: [],
      });
      return { title: outcome.title, description: outcome.description, labels: outcome.labels, ...epic };
    } catch (error) {
      log.warn(`[import] ${record.sourceUrl}: summarising failed, using the issue as written: ${messageOf(error)}`);
      return raw();
    }
  };

  /**
   * The connected MCP servers, or none when the CLI can't list them. Imports that start together share one
   * listing, and a failed one isn't kept, so the next import asks again.
   */
  const connectedServers = (cli: string | null): Promise<string[]> => {
    if (listing && Date.now() - listing.at < SERVERS_TTL_MS) return listing.list;
    const entry = {
      at: Date.now(),
      list: listServers(cli, tmpdir())
        .then((list) => {
          listError = null;
          return list;
        })
        .catch((error: unknown) => {
          listError = messageOf(error);
          log.warn(`[import] couldn't list Claude Code's MCP servers: ${listError}`);
          return [];
        })
        .then((list) => {
          if (list.length === 0 && listing === entry) listing = null;
          return list;
        }),
    };
    listing = entry;
    return entry.list;
  };

  const importTicket = async (record: ImportRecord): Promise<ImportResult> => {
    const s = deps.services();
    const settings = s.settings.get();
    if (!settings.issueImportEnabled) {
      throw new Error("Importing a ticket needs Claude Code, and issue import is turned off in Settings");
    }
    // The system recorded when the task was created, so reordering or editing the others since doesn't move it.
    const recorded = settings.ticketSystems.filter((t) => t.id === record.systemId);
    const source = parseIssueSource(record.sourceUrl, {
      ticketSystems: record.systemId ? recorded : settings.ticketSystems,
    });
    if (source?.kind !== "ticket") throw new Error(`${record.sourceUrl} is not a ticket of a configured ticket system`);
    const system = settings.ticketSystems.find((t) => t.id === source.ref.system);
    const servers = await connectedServers(settings.headlessReviewCli);
    // The run still reads every ticket as a Jira issue, and guesses its tools when none are configured, until #249.
    const tools = system?.importTools.length ? system.importTools : jiraToolRules(servers);
    if (tools.length === 0) {
      throw new Error(
        `No import tool available${listError ? ` (couldn't list Claude Code's MCP servers: ${listError})` : ""}: connect its MCP server to Claude Code (claude mcp add --scope user), or add import tools to ${system?.name ?? source.ref.system} in Settings`,
      );
    }
    const outcome = await runImport({
      cli: settings.headlessReviewCli,
      // Not the project's folder: its .mcp.json and settings are the repo's, and a run in it reads its CLAUDE.md.
      cwd: tmpdir(),
      model: resolveHeadlessModel(settings.modelTiers, settings.issueImportModel),
      budgetUsd: settings.issueImportBudgetUsd,
      source: { kind: "jira", key: source.ref.key, url: source.url },
      boardLabels: s.labels.usage().map((l) => l.name),
      jiraTools: tools,
      denyTools: writeToolDenyRules(servers, tools),
    });
    return {
      title: outcome.title,
      description: outcome.description,
      labels: outcome.labels,
      ...(outcome.epic ? { epic: outcome.epic } : {}),
    };
  };

  const runOne = async (taskId: string): Promise<void> => {
    const s = deps.services();
    // Claimed first, so a second start for the same task (or one after it finished) does nothing.
    const record = s.imports.claim(taskId);
    if (!record) return;
    try {
      if (record.attempts > MAX_IMPORT_ATTEMPTS) {
        throw new Error(`Gave up after ${MAX_IMPORT_ATTEMPTS} attempts; use Retry to try again`);
      }
      const result = await (record.sourceKind === "ticket" ? importTicket(record) : importGithub(record));
      // An epic's children each run their own import, through the same queue.
      for (const child of s.imports.complete(taskId, result).childImports) enqueue(child);
    } catch (error) {
      log.warn(`[import] ${record.sourceUrl}: ${messageOf(error)}`);
      try {
        s.imports.fail(taskId, messageOf(error));
      } catch {
        // The task was deleted while its import ran; there is nothing left to mark.
      }
    }
  };

  const pump = (): void => {
    while (running.size < CONCURRENCY && queue.length > 0) {
      const taskId = queue.shift()!;
      running.add(taskId);
      void runOne(taskId)
        .catch((error: unknown) => log.warn(`[import] ${taskId}: ${messageOf(error)}`))
        .finally(() => {
          running.delete(taskId);
          pump();
          notifyIdle();
        });
    }
  };

  const enqueue = (taskId: string): void => {
    if (running.has(taskId) || queue.includes(taskId)) return;
    queue.push(taskId);
    pump();
  };

  return {
    start: enqueue,
    resume() {
      for (const record of deps.services().imports.pending()) enqueue(record.taskId);
    },
    idle: () =>
      running.size === 0 && queue.length === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)),
  };
}
