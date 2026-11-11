import {
  addTokenUsage,
  EMPTY_TOKEN_USAGE,
  estimateCostUsd,
  MODEL_PRICES_AS_OF,
  ModelPriceOverrides,
  totalTokens,
  type AgentHarness,
  type CostSource,
  type TaskUsage,
  type TaskUsageRow,
  type UsageModelLine,
} from "@repo/contracts";
import { claudeUsageFiles, claudeUsageReader } from "../integrations/claudeUsage.ts";
import { codexUsageFile, codexUsageReader } from "../integrations/codexUsage.ts";
import type { RunModelUsage } from "../integrations/runUsage.ts";
import type { T3ThreadUsage } from "../integrations/t3Usage.ts";
import { fileSize, localDay, readUsageFile, type FileCursor, type UsageReader } from "../integrations/usageFiles.ts";
import { toLink } from "../db/repos/links.ts";
import type { SessionKey, UsageRow } from "../db/repos/sessionUsage.ts";
import type { Core } from "./core.ts";

// Token usage per session, thread and board run (docs/features/token-usage.md): read incrementally from the files
// agents write, stored per day and model, and priced when read.

/** A task's card is refreshed at most this often because of usage, so a busy session doesn't flood browsers. */
export const USAGE_TOUCH_MS = 60_000;

export interface UsageDirs {
  claudeDir: string;
  codexHome: string;
}

/** A headless run's usage, as its own output reported it. */
export interface RunUsageRecord {
  harness: AgentHarness;
  /** Its session, when it has one: a run whose session has a transcript is counted from that instead. */
  sessionId: string | null;
  runId: string;
  taskId: string | null;
  /** What it was for: an automation id or one of the board's own runs (review, import, ask, digest). */
  purpose: string;
  /** The model it ran on, for output that doesn't name one (Codex). */
  model: string | null;
  usage: readonly RunModelUsage[];
  costUsd: number | null;
  /** When it ended. */
  at: string;
}

/**
 * One stored row as the stats count it (token-usage.md): the task it counts under (the session's first linking task,
 * or the run's own task), the harness bucket (a T3 thread's sessions count as T3 threads), the automation it was for
 * (a run's purpose, or the Autopilot run that owns its session) and its cost (null without a price).
 */
export interface AttributedUsage {
  row: UsageRow;
  taskId: string | null;
  harness: string;
  purpose: string | null;
  costUsd: number | null;
  tokens: number;
}

export interface UsageService {
  /** Reads what was appended to an agent session's files since the last read; true when anything was added. */
  scanSession(ref: { harness: AgentHarness; sessionId: string; cwd?: string | null }): boolean;
  /** Reads a T3 thread: each provider session behind it from its transcript, else from T3's turns. */
  scanThread(threadId: string): Promise<boolean>;
  /** Stores a headless run's own usage, unless its session has a transcript (which is read instead). */
  recordRun(run: RunUsageRecord): void;
  /** Reads every linked session, and every thread not read before (archived tasks included). */
  sweep(): Promise<void>;
  /** A task's usage: every session and thread it links, in full, and its board runs. Null when there is none. */
  taskUsage(taskId: string): TaskUsage | null;
  /** Every row used on the local days `[fromDay, toDay)`, attributed and priced once for stats and board_activity. */
  attributed(fromDay: string, toDay: string): AttributedUsage[];
  /** Cost of rows in the board's price table and the user's overrides; null when the model has no price. */
  rowCost(row: Pick<UsageRow, "model" | "tokens" | "reportedCostUsd" | "source">): number | null;
  /** Stops the deferred card refreshes (shutdown, tests). */
  stop(): void;
}

type StoredCursor = { guard: string; s: unknown };

const readerFor = (harness: AgentHarness, sessionId: string): UsageReader<unknown> | null =>
  harness === "claude-code" ? claudeUsageReader(sessionId) : harness === "codex" ? codexUsageReader : null;

export function createUsageService(
  core: Core,
  deps: {
    dirs: UsageDirs;
    /** Fetches a T3 thread's usage; null when T3 Code can't be asked (not running, no token). */
    fetchThread?: (threadId: string) => Promise<T3ThreadUsage | null>;
  },
): UsageService {
  const { repos } = core;
  const usage = repos.sessionUsage;
  const touchedAt = new Map<string, number>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    const ids = [...pending];
    pending.clear();
    const now = core.now().getTime();
    core.write((fx) => {
      for (const id of ids) {
        if (!repos.tasks.getAny(id)) continue;
        touchedAt.set(id, now);
        fx.task(id);
      }
    });
  };

  /** Marks tasks' cards changed, at most once a minute each; a later change waits for its minute. */
  const touch = (taskIds: readonly string[]) => {
    const now = core.now().getTime();
    const due: string[] = [];
    for (const id of taskIds) {
      const last = touchedAt.get(id) ?? 0;
      if (now - last >= USAGE_TOUCH_MS) due.push(id);
      else pending.add(id);
    }
    if (due.length > 0) {
      core.write((fx) => {
        for (const id of due) {
          touchedAt.set(id, now);
          fx.task(id);
        }
      });
    }
    if (pending.size > 0 && !timer) {
      timer = setTimeout(flush, USAGE_TOUCH_MS);
      timer.unref?.();
    }
  };

  const filesOf = (harness: AgentHarness, sessionId: string, cwd: string | null | undefined) => {
    if (harness === "claude-code") return claudeUsageFiles(deps.dirs.claudeDir, sessionId, cwd ?? undefined);
    if (harness === "codex") {
      const file = codexUsageFile(deps.dirs.codexHome, sessionId);
      return file ? [file] : [];
    }
    // Copilot CLI: not read yet (docs/features/token-usage.md#copilot-cli).
    return [];
  };

  /** Reads a session's files; null when it has none here. */
  const readSession = (harness: AgentHarness, sessionId: string, cwd?: string | null): boolean | null => {
    const id = sessionId.toLowerCase();
    const files = filesOf(harness, id, cwd);
    const reader = readerFor(harness, id);
    if (files.length === 0 || !reader) return null;
    const key: SessionKey = { harness, sessionId: id };
    let added = false;
    for (const file of files) {
      const stored = usage.cursor(key, file.sourceFile);
      const size = fileSize(file.path);
      // Unchanged since the last read: nothing to open.
      if (stored && size === stored.size && size === stored.offset) continue;
      const state = stored?.state as StoredCursor | null;
      const cursor: FileCursor<unknown> | null =
        stored && state ? { offset: stored.offset, size: stored.size, guard: state.guard, state: state.s } : null;
      const read = readUsageFile(file.path, cursor, reader);
      if (!read) continue;
      const rows = read.buckets.map((b): UsageRow => ({
        ...key,
        sourceFile: file.sourceFile,
        day: b.day,
        model: b.model,
        source: "transcript",
        taskId: null,
        purpose: null,
        tokens: b.tokens,
        reportedCostUsd: null,
      }));
      core.write(() => {
        if (read.restarted || !stored) usage.replaceFile(key, file.sourceFile, rows);
        else usage.add(rows);
        usage.setCursor(key, file.sourceFile, {
          offset: read.cursor.offset,
          size: read.cursor.size,
          state: { guard: read.cursor.guard, s: read.cursor.state } satisfies StoredCursor,
        });
        // The transcript is the session's one source: drop what a run reported for it.
        if (rows.length > 0) usage.deleteOtherSources(key, "transcript");
      });
      if (rows.length > 0 || read.restarted) added = true;
    }
    return added;
  };

  const scanSession: UsageService["scanSession"] = ({ harness, sessionId, cwd }) => {
    const added = readSession(harness, sessionId, cwd) ?? false;
    if (added) touch(usage.tasksForSession({ harness, sessionId: sessionId.toLowerCase() }).map((t) => t.id));
    return added;
  };

  const scanThread: UsageService["scanThread"] = async (threadId) => {
    const thread = await deps.fetchThread?.(threadId).catch(() => null);
    if (!thread) return false;
    const behind: SessionKey[] = [];
    const fallback: UsageRow[] = [];
    let added = false;
    const t3Key: SessionKey = { harness: "t3", sessionId: threadId };
    for (const provider of thread.providerThreads) {
      const native =
        provider.harness && provider.nativeId
          ? { harness: provider.harness, sessionId: provider.nativeId.toLowerCase() }
          : null;
      const fromTranscript = native ? readSession(native.harness, provider.nativeId!) : null;
      // A transcript read before stays the source once its file is gone (Claude Code's 30-day cleanup): falling back
      // to T3's turns then would count the same turns twice.
      const readBefore = native !== null && usage.cursorFiles(native).length > 0;
      if (provider.harness && provider.nativeId && (fromTranscript !== null || readBefore)) {
        behind.push({ harness: provider.harness, sessionId: provider.nativeId });
        added ||= fromTranscript ?? false;
        continue;
      }
      // No transcript here (a remote T3, a cleaned-up file) or no reader for its driver: T3's own turns.
      for (const bucket of thread.turns.get(provider.id) ?? []) {
        fallback.push({
          ...t3Key,
          sourceFile: provider.id,
          day: bucket.day,
          model: bucket.model,
          source: "t3_turn",
          taskId: null,
          purpose: null,
          tokens: bucket.tokens,
          reportedCostUsd: null,
        });
      }
    }
    core.write(() => {
      const before = JSON.stringify(
        usage.rowsForSessions([t3Key]).map((r) => [r.sourceFile, r.day, r.model, r.tokens]),
      );
      // T3's turns are a running total: replace them whole on each read.
      for (const file of new Set(usage.rowsForSessions([t3Key]).map((r) => r.sourceFile)))
        usage.replaceFile(t3Key, file, []);
      usage.add(fallback);
      if (fallback.length > 0) behind.push(t3Key);
      usage.setThreadSessions(threadId, behind);
      const after = JSON.stringify(usage.rowsForSessions([t3Key]).map((r) => [r.sourceFile, r.day, r.model, r.tokens]));
      if (before !== after) added = true;
    });
    if (added) touch(usage.tasksForThread(threadId).map((t) => t.id));
    return added;
  };

  const recordRun: UsageService["recordRun"] = (run) => {
    if (run.usage.length === 0 && run.costUsd === null) return;
    // A run whose session keeps a transcript is counted from it, never twice.
    if (run.sessionId && filesOf(run.harness, run.sessionId.toLowerCase(), null).length > 0) {
      scanSession({ harness: run.harness, sessionId: run.sessionId });
      return;
    }
    const day = localDay(run.at) ?? localDay(core.now().toISOString())!;
    const key: SessionKey = { harness: run.harness, sessionId: (run.sessionId ?? run.runId).toLowerCase() };
    const lines = run.usage.length > 0 ? run.usage : [{ model: run.model, tokens: EMPTY_TOKEN_USAGE }];
    const rows = lines.map((line, i): UsageRow => ({
      ...key,
      sourceFile: "",
      day,
      model: line.model ?? run.model ?? "",
      source: "run_output",
      taskId: run.taskId,
      purpose: run.purpose,
      tokens: line.tokens,
      // The run's whole reported cost goes on its first line, so the sum stays right.
      reportedCostUsd: i === 0 ? run.costUsd : null,
    }));
    core.write(() => usage.replaceFile(key, "", rows));
    if (run.taskId) touch([run.taskId]);
  };

  const sweep: UsageService["sweep"] = async () => {
    const { sessions, threads } = usage.linkedSources();
    for (const s of sessions) {
      if (s.harness === "t3") continue;
      try {
        scanSession({ harness: s.harness, sessionId: s.sessionId, cwd: s.cwd });
      } catch {
        // One unreadable file doesn't stop the rest.
      }
    }
    for (const threadId of threads) {
      if (!usage.hasThread(threadId)) await scanThread(threadId);
    }
  };

  const overrides = () => ModelPriceOverrides.safeParse(repos.settings.get("modelPriceOverrides") ?? {}).data ?? {};

  const rowCost: UsageService["rowCost"] = (row) =>
    row.source === "run_output" && row.reportedCostUsd !== null
      ? row.reportedCostUsd
      : estimateCostUsd(row.model || null, row.tokens, overrides());

  const attributed: UsageService["attributed"] = (fromDay, toDay) => {
    const owners = usage.owners();
    const automations = usage.runAutomations();
    const prices = overrides();
    return usage.rowsBetween(fromDay, toDay).map((row) => {
      const owner = row.taskId
        ? { taskId: row.taskId, viaThread: false }
        : (owners.get(`${row.harness}:${row.sessionId}`) ?? null);
      const t = row.tokens;
      return {
        row,
        taskId: owner?.taskId ?? null,
        harness: row.harness === "t3" || owner?.viaThread ? "t3_thread" : row.harness,
        purpose: row.purpose ?? automations.get(row.sessionId) ?? null,
        costUsd:
          row.source === "run_output" && row.reportedCostUsd !== null
            ? row.reportedCostUsd
            : estimateCostUsd(row.model || null, t, prices),
        tokens: t.input + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h,
      };
    });
  };

  /** One task-usage row from stored rows: per model, priced, with what it cost in total. */
  const buildRow = (
    base: Pick<TaskUsageRow, "key" | "kind" | "harness" | "sessionId" | "linkId" | "label" | "purpose" | "sharedWith">,
    rows: readonly UsageRow[],
    untracked: boolean,
  ): TaskUsageRow => {
    const prices = overrides();
    const byModel = new Map<string, UsageModelLine>();
    let reported = 0;
    let anyReported = false;
    for (const row of rows) {
      const model = row.model || null;
      const line = byModel.get(row.model) ?? { model, tokens: EMPTY_TOKEN_USAGE, costUsd: null };
      line.tokens = addTokenUsage(line.tokens, row.tokens);
      byModel.set(row.model, line);
      if (row.source === "run_output" && row.reportedCostUsd !== null) {
        reported += row.reportedCostUsd;
        anyReported = true;
      }
    }
    // Largest first, so the model column names the one that did most of the work.
    const models = [...byModel.values()]
      .map((line) => ({ ...line, costUsd: estimateCostUsd(line.model, line.tokens, prices) }))
      .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
    const tokens = models.reduce((sum, m) => addTokenUsage(sum, m.tokens), EMPTY_TOKEN_USAGE);
    const unpricedTokens = models.filter((m) => m.costUsd === null).reduce((n, m) => n + totalTokens(m.tokens), 0);
    const estimated = models.filter((m) => m.costUsd !== null);
    const costSource: CostSource = anyReported ? "reported" : estimated.length > 0 ? "estimated" : "unknown";
    const costUsd = anyReported
      ? reported
      : estimated.length > 0
        ? estimated.reduce((n, m) => n + m.costUsd!, 0)
        : null;
    const days = rows.map((r) => r.day).sort();
    return {
      ...base,
      source: rows[0]?.source ?? (base.kind === "run" ? "run_output" : "transcript"),
      models,
      tokens,
      costUsd,
      costSource,
      unpricedTokens: anyReported ? 0 : unpricedTokens,
      untracked,
      lastDay: days.at(-1) ?? null,
    };
  };

  const taskUsage: UsageService["taskUsage"] = (taskId) => {
    const task = repos.tasks.getAny(taskId);
    if (!task) return null;
    const links = repos.links.forTasks([taskId]).map(toLink);
    const result: TaskUsageRow[] = [];
    const shown = new Set<string>();
    const others = (list: Array<{ id: string; number: number }>) =>
      list.filter((t) => t.id !== taskId).map((t) => t.number);

    for (const link of links) {
      if (link.kind !== "agent_session" || !link.ref.sessionId) continue;
      const key: SessionKey = { harness: link.ref.harness, sessionId: link.ref.sessionId.toLowerCase() };
      const id = `${key.harness}:${key.sessionId}`;
      if (shown.has(id)) continue;
      shown.add(id);
      const rows = usage.rowsForSessions([key]);
      result.push(
        buildRow(
          {
            key: id,
            kind: "session",
            harness: key.harness,
            sessionId: key.sessionId,
            linkId: link.id,
            label: link.label ?? link.snapshot?.title ?? null,
            purpose: null,
            sharedWith: others(usage.tasksForSession(key)),
          },
          rows,
          // Copilot CLI writes nothing the board can read until the session ends.
          rows.length === 0 && key.harness === "copilot-cli",
        ),
      );
    }
    for (const link of links) {
      if (link.kind !== "t3_thread") continue;
      const threadId = link.ref.threadId;
      const keys = usage.threadSessions(threadId).filter((k) => !shown.has(`${k.harness}:${k.sessionId}`));
      if (keys.length === 0) continue;
      keys.forEach((k) => shown.add(`${k.harness}:${k.sessionId}`));
      result.push(
        buildRow(
          {
            key: `t3:${threadId}`,
            kind: "thread",
            harness: "t3",
            sessionId: threadId,
            linkId: link.id,
            label: link.snapshot?.title ?? link.label ?? null,
            purpose: null,
            sharedWith: others(usage.tasksForThread(threadId)),
          },
          usage.rowsForSessions(keys),
          false,
        ),
      );
    }
    const runs = new Map<string, UsageRow[]>();
    for (const row of usage.rowsForTask(taskId)) {
      const id = `${row.harness}:${row.sessionId}`;
      if (shown.has(id)) continue;
      runs.set(id, [...(runs.get(id) ?? []), row]);
    }
    for (const [id, rows] of runs) {
      result.push(
        buildRow(
          {
            key: id,
            kind: "run",
            harness: rows[0]!.harness,
            sessionId: rows[0]!.sessionId,
            linkId: null,
            label: null,
            purpose: rows[0]!.purpose,
            sharedWith: [],
          },
          rows,
          false,
        ),
      );
    }
    if (result.length === 0) return null;
    const tokens = result.reduce((sum, r) => addTokenUsage(sum, r.tokens), EMPTY_TOKEN_USAGE);
    const priced = result.filter((r) => r.costUsd !== null);
    const costSource: CostSource =
      priced.length === 0 ? "unknown" : priced.every((r) => r.costSource === "reported") ? "reported" : "estimated";
    return {
      rows: result,
      tokens,
      costUsd: priced.length === 0 ? null : priced.reduce((n, r) => n + r.costUsd!, 0),
      costSource,
      unpricedTokens: result.reduce((n, r) => n + r.unpricedTokens, 0),
      pricesAsOf: MODEL_PRICES_AS_OF,
    };
  };

  return {
    scanSession,
    scanThread,
    recordRun,
    sweep,
    taskUsage,
    rowCost,
    attributed,
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}
