import { addTokenUsage, type TokenUsage, type UsageHarness } from "@repo/contracts";
import { ShellError, type FetchFn } from "./t3.ts";
import { count, localDay, objectAt, tokens, type UsageBucket } from "./usageFiles.ts";

// Token usage of a T3 Code thread (docs/features/token-usage.md). The thread's projection names the provider sessions
// behind it (a hand-off or fork adds more); each is read from its own transcript where the board has a reader and the
// file is here. The rest are counted from T3's per-turn usage. Parsed by hand and leniently: the installed T3 is often
// newer than the protocol this was written against, and a field that isn't there counts as nothing.

const THREAD_TIMEOUT_MS = 10_000;

/** T3's provider drivers whose sessions the board can read from their transcript. */
const DRIVER_HARNESS: Readonly<Record<string, Exclude<UsageHarness, "t3">>> = {
  claudeAgent: "claude-code",
  claudeCode: "claude-code",
  codex: "codex",
  copilot: "copilot-cli",
  githubCopilot: "copilot-cli",
};

/** One provider thread behind a T3 thread. */
export interface T3ProviderThread {
  /** T3's id for it; T3-turn usage is stored per provider thread, under this name. */
  id: string;
  driver: string;
  /** The harness whose transcript holds it, or null when the board has no reader for the driver. */
  harness: Exclude<UsageHarness, "t3"> | null;
  /** The provider's own session or thread id; null when T3 doesn't know it yet. */
  nativeId: string | null;
}

export interface T3ThreadUsage {
  providerThreads: T3ProviderThread[];
  /** T3's per-turn usage summed by provider thread, local day and model. */
  turns: Map<string, UsageBucket[]>;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * T3's turn usage in the board's form. Its inputTokens include cache reads and writes, and reasoning is part of
 * output. A turn with no usage, or one T3 marks unavailable, counts nothing.
 */
export function t3TurnTokens(raw: unknown): TokenUsage | null {
  const usage = objectAt(raw);
  if (!usage || usage.usageStatus === "unavailable") return null;
  const cacheRead = count(usage.cachedInputTokens);
  const cacheWrite = count(usage.cacheCreationTokens);
  const result = tokens({
    input: Math.max(0, count(usage.inputTokens) - cacheRead - cacheWrite),
    output: count(usage.outputTokens),
    cacheRead,
    cacheWrite5m: cacheWrite,
  });
  return result.input + result.output + result.cacheRead + result.cacheWrite5m > 0 ? result : null;
}

/** Reads the parts of a thread projection usage needs. */
export function parseThreadUsage(snapshot: unknown): T3ThreadUsage {
  const projection = objectAt(objectAt(snapshot)?.projection) ?? objectAt(snapshot) ?? {};
  const providerThreads: T3ProviderThread[] = [];
  for (const raw of list(projection.providerThreads)) {
    const thread = objectAt(raw);
    const id = text(thread?.id);
    const driver = text(thread?.driver);
    if (!thread || !id || !driver) continue;
    providerThreads.push({
      id,
      driver,
      harness: DRIVER_HARNESS[driver] ?? null,
      nativeId: text(objectAt(thread.nativeThreadRef)?.nativeId)?.toLowerCase() ?? null,
    });
  }

  // A turn's model: its own list (newer T3), else the model its run was started with.
  const runModel = new Map<string, string>();
  for (const raw of list(projection.runs)) {
    const run = objectAt(raw);
    const id = text(run?.id);
    const model = text(objectAt(run?.modelSelection)?.model);
    if (id && model) runModel.set(id, model);
  }
  const attemptModel = new Map<string, string>();
  for (const raw of list(projection.attempts)) {
    const attempt = objectAt(raw);
    const id = text(attempt?.id);
    const model = runModel.get(text(attempt?.runId) ?? "");
    if (id && model) attemptModel.set(id, model);
  }

  const turns = new Map<string, Map<string, UsageBucket>>();
  for (const raw of list(projection.providerTurns)) {
    const turn = objectAt(raw);
    const providerThreadId = text(turn?.providerThreadId);
    const usage = t3TurnTokens(turn?.turnTokenUsage);
    const day = localDay(turn?.completedAt ?? turn?.startedAt);
    if (!turn || !providerThreadId || !usage || !day) continue;
    const model = list(turn.models).map(text).find(Boolean) ?? attemptModel.get(text(turn.runAttemptId) ?? "") ?? "";
    const buckets = turns.get(providerThreadId) ?? new Map<string, UsageBucket>();
    const key = `${day}\u0000${model}`;
    const bucket = buckets.get(key);
    buckets.set(
      key,
      bucket ? { ...bucket, tokens: addTokenUsage(bucket.tokens, usage) } : { day, model, tokens: usage },
    );
    turns.set(providerThreadId, buckets);
  }
  return {
    providerThreads,
    turns: new Map([...turns].map(([id, buckets]) => [id, [...buckets.values()]])),
  };
}

/** GET /api/orchestration/threads/:threadId, with the same token as the shell call. */
export async function fetchThreadUsage(
  origin: string,
  token: string,
  threadId: string,
  fetchFn: FetchFn,
): Promise<T3ThreadUsage> {
  let response: Response;
  try {
    response = await fetchFn(`${origin}/api/orchestration/threads/${encodeURIComponent(threadId)}`, {
      headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2", accept: "application/json" },
      signal: AbortSignal.timeout(THREAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ShellError(`T3 Code unreachable: ${error instanceof Error ? error.message : String(error)}`, true);
  }
  if (!response.ok) throw new ShellError(`T3 Code returned HTTP ${response.status} for thread ${threadId}`);
  return parseThreadUsage(await response.json().catch(() => null));
}
