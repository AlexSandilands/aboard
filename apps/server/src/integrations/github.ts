import { execFile } from "node:child_process";
import type { GithubStatus, PrSnapshot, TaskLink } from "@taskboard/contracts";
import { z } from "zod";
import { AppError } from "../errors.ts";
import type { LinksService, SettingsService } from "../services/types.ts";
import { mapWithConcurrency, type Logger } from "./util.ts";

export const PR_POLL_INTERVAL_MS = 2 * 60_000;
export const GH_STATUS_INTERVAL_MS = 10 * 60_000;
const GH_TIMEOUT_MS = 30_000;
const PR_CONCURRENCY = 4;
const PR_FIELDS = "number,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup,headRefName,updatedAt";

/** Runs `gh` with the given args and resolves stdout. Rejects with a GhError on failure. */
export type RunGh = (args: string[], opts?: { timeoutMs?: number }) => Promise<string>;

export class GhError extends Error {
  constructor(
    message: string,
    /** True when the gh binary could not be found. */
    readonly notFound: boolean,
  ) {
    super(message);
    this.name = "GhError";
  }
}

/**
 * Spawns gh without a shell. On Windows libuv resolves "gh" to gh.exe via PATH, so no
 * extension or shell is needed (verified with gh 2.96 on Windows 11).
 */
export const defaultRunGh: RunGh = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { timeout: opts?.timeoutMs ?? GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new GhError("gh CLI not found", true));
        if (error.killed) return reject(new GhError(`gh ${args[0] ?? ""} timed out`, false));
        const detail = stderr.trim().split(/\r?\n/)[0] || error.message;
        reject(new GhError(detail, false));
      },
    );
  });

// ── Pure mapping ─────────────────────────────────────────────────────────

const RollupItem = z
  .object({
    __typename: z.string().optional(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    state: z.string().nullish(),
  })
  .loose();

export const GhPrJson = z.object({
  number: z.number().optional(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  reviewDecision: z.string().nullish(),
  mergeable: z.string().nullish(),
  statusCheckRollup: z.array(RollupItem).nullish(),
  headRefName: z.string().nullish(),
  updatedAt: z.string().nullish(),
});
export type GhPrJson = z.infer<typeof GhPrJson>;

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** One rollup entry's effective state: StatusContext.state, or CheckRun conclusion once completed. */
function rollupItemState(item: z.infer<typeof RollupItem>): string {
  if (item.state) return item.state.toUpperCase();
  const status = item.status?.toUpperCase();
  if (status && status !== "COMPLETED") return status;
  return item.conclusion ? item.conclusion.toUpperCase() : status === "COMPLETED" ? "SUCCESS" : "PENDING";
}

export function mapChecks(rollup: ReadonlyArray<z.infer<typeof RollupItem>> | null | undefined): PrSnapshot["checks"] {
  if (!rollup || rollup.length === 0) return "none";
  const states = rollup.map(rollupItemState);
  if (states.some((s) => FAILING.has(s))) return "failing";
  if (states.some((s) => PENDING.has(s))) return "pending";
  return "passing";
}

/** Maps `gh pr view --json` output to a PrSnapshot. */
export function mapPrSnapshot(pr: GhPrJson): PrSnapshot {
  const rawState = pr.state.toUpperCase();
  const state: PrSnapshot["state"] =
    rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const review = pr.reviewDecision?.toUpperCase();
  const reviewDecision: PrSnapshot["reviewDecision"] =
    review === "APPROVED"
      ? "approved"
      : review === "CHANGES_REQUESTED"
        ? "changes_requested"
        : review === "REVIEW_REQUIRED"
          ? "review_required"
          : null;
  const merge = pr.mergeable?.toUpperCase();
  const mergeable: PrSnapshot["mergeable"] =
    merge === "MERGEABLE" ? "mergeable" : merge === "CONFLICTING" ? "conflicting" : "unknown";
  return {
    state,
    title: pr.title,
    checks: mapChecks(pr.statusCheckRollup),
    reviewDecision,
    mergeable,
    headRef: pr.headRefName || null,
    updatedAt: pr.updatedAt || null,
  };
}

// ── Poller ───────────────────────────────────────────────────────────────

export interface GithubServices {
  links: Pick<LinksService, "listByKind" | "get" | "setSnapshot">;
  settings: Pick<SettingsService, "get">;
}

type PrLink = Extract<TaskLink, { kind: "pr" }>;

function isGithubPr(link: TaskLink): link is PrLink & { ref: NonNullable<PrLink["ref"]> } {
  return link.kind === "pr" && link.ref?.host === "github.com";
}

export interface GithubIntegration {
  status(): GithubStatus;
  /** Re-detects gh and its auth state. */
  checkStatus(): Promise<GithubStatus>;
  /** One poll over all GitHub PR links (no-op when polling is off or gh is unusable). */
  pollAll(): Promise<void>;
  /** Fetches one PR link now. Returns false when the link is not a GitHub PR. Throws AppError on failure. */
  refresh(link: TaskLink): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createGithubIntegration(deps: {
  services: () => GithubServices;
  runGh?: RunGh;
  log?: Logger;
}): GithubIntegration {
  const runGh = deps.runGh ?? defaultRunGh;
  const log = deps.log ?? console;
  let status: GithubStatus = { available: false, authenticated: false, error: null };
  let checkedAt = 0;
  let checking: Promise<GithubStatus> | null = null;
  let polling = false;
  const timers: NodeJS.Timeout[] = [];
  /** Last error logged per link, so a persistent failure is logged once. */
  const loggedErrors = new Map<string, string>();

  const checkStatus = (): Promise<GithubStatus> => {
    checking ??= (async () => {
      try {
        await runGh(["--version"], { timeoutMs: 10_000 });
      } catch (error) {
        const notFound = error instanceof GhError && error.notFound;
        return { available: false, authenticated: false, error: notFound ? "gh CLI not found" : messageOf(error) };
      }
      try {
        await runGh(["auth", "status"], { timeoutMs: 15_000 });
        return { available: true, authenticated: true, error: null };
      } catch {
        return { available: true, authenticated: false, error: "gh is not authenticated (run `gh auth login`)" };
      }
    })().then((next) => {
      status = next;
      checkedAt = Date.now();
      checking = null;
      return next;
    });
    return checking;
  };

  const ensureStatus = async (): Promise<GithubStatus> =>
    checkedAt === 0 || Date.now() - checkedAt > GH_STATUS_INTERVAL_MS ? checkStatus() : status;

  const fetchSnapshot = async (link: PrLink & { ref: NonNullable<PrLink["ref"]> }): Promise<PrSnapshot> => {
    const url = `https://github.com/${link.ref.repo}/pull/${link.ref.number}`;
    const stdout = await runGh(["pr", "view", url, "--json", PR_FIELDS], { timeoutMs: GH_TIMEOUT_MS });
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new GhError("gh returned invalid JSON", false);
    }
    const parsed = GhPrJson.safeParse(json);
    if (!parsed.success) throw new GhError("gh returned an unexpected PR shape", false);
    return mapPrSnapshot(parsed.data);
  };

  const pollAll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const services = deps.services();
      if (!services.settings.get().githubPolling) return;
      const current = await ensureStatus();
      if (!current.authenticated) return;
      const links = services.links.listByKind("pr").filter(isGithubPr);
      await mapWithConcurrency(links, PR_CONCURRENCY, async (link) => {
        try {
          const snapshot = await fetchSnapshot(link);
          services.links.setSnapshot(link.id, snapshot);
          loggedErrors.delete(link.id);
        } catch (error) {
          const message = messageOf(error);
          if (loggedErrors.get(link.id) !== message) {
            loggedErrors.set(link.id, message);
            log.warn(`[github] ${link.url}: ${message}`);
          }
        }
      });
    } catch (error) {
      log.warn(`[github] poll failed: ${messageOf(error)}`);
    } finally {
      polling = false;
    }
  };

  return {
    status: () => {
      if (checkedAt === 0 && !checking) void checkStatus();
      return status;
    },
    checkStatus,
    pollAll,
    async refresh(link) {
      if (!isGithubPr(link)) return false;
      const current = await ensureStatus();
      if (!current.available) throw new AppError("VALIDATION", "GitHub CLI (gh) is not installed");
      if (!current.authenticated) throw new AppError("VALIDATION", "GitHub CLI (gh) is not authenticated");
      try {
        deps.services().links.setSnapshot(link.id, await fetchSnapshot(link));
        loggedErrors.delete(link.id);
      } catch (error) {
        throw new AppError("VALIDATION", `Could not fetch PR: ${messageOf(error)}`);
      }
      return true;
    },
    start() {
      void checkStatus().then(() => pollAll());
      timers.push(setInterval(() => void checkStatus(), GH_STATUS_INTERVAL_MS).unref());
      timers.push(setInterval(() => void pollAll(), PR_POLL_INTERVAL_MS).unref());
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
