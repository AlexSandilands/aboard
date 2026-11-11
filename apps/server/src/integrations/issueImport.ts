import {
  type AgentHarness,
  harnessCliSetting,
  IMPORT_TICKET_NEEDS,
  parseImportSource,
  resolveOperationModel,
  type MilestoneRef,
  type TaskLink,
} from "@repo/contracts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { ImportRecord } from "../db/repos/imports.ts";
import { IMPORT_CHILDREN_MAX } from "../services/imports.ts";
import type { ImportResult, Services } from "../services/types.ts";
import type { HostIssue, HostMilestone } from "./gitHost.ts";
import { messageOf } from "./util.ts";
import {
  listConnectedMcpServers,
  runIssueImport,
  writeToolDenyRules,
  type ImportOutcome,
  type IssueSource,
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

/** What an import reads of an issue. */
export type IssueDetails = Pick<HostIssue, "title" | "body" | "labels" | "state">;

export interface IssueImporter {
  /** Queues the task's pending import; it runs in the background. */
  start(taskId: string): void;
  /** Queues every pending import, for after a restart. */
  resume(): void;
  /** Resolves when nothing is running or queued. */
  idle(): Promise<void>;
}

/**
 * Fills in tasks created from a ticket, a GitHub issue or a GitHub milestone: reads the issue, has a small model turn it into a title,
 * description and labels, and records the result (or why it failed) on the task's import. A GitHub issue still
 * imports, as its raw title and body, when the model can't run. A ticket can only be read by the model, through the
 * user's own MCP server for its system.
 */
export function createIssueImporter(deps: {
  services: () => Services;
  /** The git host an issue is on (GitHosts' gitHostIssues). */
  issues: {
    getIssue(ref: { host: string; repo: string; number: number }): Promise<IssueDetails>;
    listSubIssues(ref: { host: string; repo: string; number: number }): Promise<string[]>;
    getMilestone(ref: MilestoneRef): Promise<Pick<HostMilestone, "title" | "description">>;
    /** The URLs of the milestone's open issues, without its pull requests. */
    listMilestoneIssues(ref: MilestoneRef): Promise<string[]>;
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
    const source = parseImportSource(record.sourceUrl, s.settings.get().ticketSystems);
    if (source?.kind !== "issue") throw new Error(`${record.sourceUrl} is not a GitHub issue`);
    const issue = await deps.issues.getIssue(source.ref);
    const link = issueLink(record.taskId);
    if (link) s.links.setSnapshot(link.id, { state: issue.state, title: issue.title });
    // An issue with sub-issues is GitHub's epic. Without them (or when they can't be read) it is a plain task. A task
    // already in an epic (an epic's own child) can't become one, since epics don't nest, so it isn't asked.
    const inEpic = s.tasks.summary(record.taskId).parent !== null;
    const subIssues = inEpic
      ? []
      : await deps.issues.listSubIssues(source.ref).catch((error: unknown) => {
          log.warn(`[import] ${record.sourceUrl}: couldn't read its sub-issues: ${messageOf(error)}`);
          return [];
        });
    const epic = subIssues.length > 0 ? { epic: { children: subIssues, total: subIssues.length } } : {};

    return summarise(
      record,
      {
        kind: "issue",
        repo: source.ref.repo,
        number: source.ref.number,
        url: source.url,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      },
      epic,
    );
  };

  /**
   * A GitHub milestone becomes an epic, and its open issues its tasks. Unlike an issue's sub-issues, a failed read of
   * its issues fails the import: they are what a milestone is imported for.
   */
  const importMilestone = async (record: ImportRecord): Promise<ImportResult> => {
    const s = deps.services();
    const source = parseImportSource(record.sourceUrl, s.settings.get().ticketSystems);
    if (source?.kind !== "milestone") throw new Error(`${record.sourceUrl} is not a GitHub milestone`);
    const milestone = await deps.issues.getMilestone(source.ref);
    const issues = await deps.issues.listMilestoneIssues(source.ref);
    return summarise(
      record,
      {
        kind: "milestone",
        repo: source.ref.repo,
        number: source.ref.number,
        url: source.url,
        title: milestone.title,
        body: milestone.description,
      },
      { epic: { children: issues.slice(0, IMPORT_CHILDREN_MAX), total: issues.length } },
    );
  };

  /** The import run keeps no session, so its own output is the only record of what it used (token-usage.md). */
  const recordUsage = (
    taskId: string,
    run: { provider: AgentHarness; model: string | null },
    outcome: Pick<ImportOutcome, "usage" | "costUsd">,
  ) => {
    deps.services().usage.recordRun({
      harness: run.provider,
      sessionId: null,
      // Each run its own id: a retry adds to the task's import spend rather than replacing it.
      runId: `import-${taskId}-${randomUUID()}`,
      taskId,
      purpose: "import",
      model: run.model,
      usage: outcome.usage ?? [],
      costUsd: outcome.costUsd,
      at: new Date().toISOString(),
    });
  };

  /**
   * Has the model turn a GitHub issue or milestone into a title, summary and labels. When it can't run (turned off, no
   * provider, a failure) the source's own title, body and labels stand, so the import still succeeds.
   */
  const summarise = async (
    record: ImportRecord,
    source: Exclude<IssueSource, { kind: "ticket" }>,
    epic: Pick<ImportResult, "epic">,
  ): Promise<ImportResult> => {
    const s = deps.services();
    const raw = (): ImportResult => ({
      title: source.title,
      description: source.body.trim() ? source.body.trim().slice(0, RAW_BODY_MAX) : null,
      labels: source.kind === "issue" ? source.labels : [],
      ...epic,
    });
    const settings = s.settings.get();
    if (!settings.issueImportEnabled) return raw();
    const resolved = resolveOperationModel("issueImport", {}, settings);
    if (!resolved.ok) {
      log.warn(`[import] ${record.sourceUrl}: not summarised, using the ${source.kind} as written: ${resolved.reason}`);
      return raw();
    }
    // Only a provider the user chose carries one (resolveOperationModel never falls back to it).
    if (resolved.warning) log.warn(`[import] ${record.sourceUrl}: ${resolved.warning}`);
    try {
      const outcome = await runImport({
        provider: resolved.provider,
        cli: harnessCliSetting(settings, resolved.provider),
        cwd: tmpdir(),
        model: resolved.model,
        effort: resolved.effort,
        budgetUsd: settings.issueImportBudgetUsd,
        source,
        boardLabels: s.labels.usage().map((l) => l.name),
        importTools: [],
        denyTools: [],
      });
      recordUsage(record.taskId, resolved, outcome);
      return { title: outcome.title, description: outcome.description, labels: outcome.labels, ...epic };
    } catch (error) {
      log.warn(
        `[import] ${record.sourceUrl}: summarising failed, using the ${source.kind} as written: ${messageOf(error)}`,
      );
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
        .catch((error: unknown) => {
          log.warn(`[import] couldn't list Claude Code's MCP servers: ${messageOf(error)}`);
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
    const systems = record.systemId ? recorded : settings.ticketSystems;
    const source = parseImportSource(record.sourceUrl, systems);
    const system = source?.kind === "ticket" ? systems.find((t) => t.id === source.ref.system) : undefined;
    if (source?.kind !== "ticket" || !system) {
      throw new Error(`${record.sourceUrl} is not a ticket of a configured ticket system`);
    }
    // Only the tools the system lists are allowed: the board doesn't guess which tools read tickets.
    if (system.importTools.length === 0) {
      throw new Error(`Add import tools to ${system.name} in Settings → Integrations → Ticket systems`);
    }
    // A ticket is read through the user's own MCP servers, held to the system's tools by tool rules.
    const resolved = resolveOperationModel("issueImport", { needs: IMPORT_TICKET_NEEDS }, settings);
    if (!resolved.ok) throw new Error(resolved.reason);
    const cli = harnessCliSetting(settings, resolved.provider);
    const servers = await connectedServers(cli);
    const outcome = await runImport({
      provider: resolved.provider,
      cli,
      // Not the project's folder: its .mcp.json and settings are the repo's, and a run in it reads its CLAUDE.md.
      cwd: tmpdir(),
      model: resolved.model,
      effort: resolved.effort,
      budgetUsd: settings.issueImportBudgetUsd,
      source: {
        kind: "ticket",
        key: source.ref.key,
        url: source.url,
        system: { name: system.name, importInstructions: system.importInstructions },
      },
      boardLabels: s.labels.usage().map((l) => l.name),
      importTools: system.importTools,
      denyTools: writeToolDenyRules(servers, system.importTools),
    });
    recordUsage(record.taskId, resolved, outcome);
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
      const result = await (record.sourceKind === "ticket"
        ? importTicket(record)
        : record.sourceKind === "milestone"
          ? importMilestone(record)
          : importGithub(record));
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
