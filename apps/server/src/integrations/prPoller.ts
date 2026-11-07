import type { TaskLink } from "@repo/contracts";
import { AppError } from "../errors.ts";
import type { LinksService, SettingsService } from "../services/types.ts";
import { isHostWideError, type GitHost } from "./gitHost.ts";
import type { GitHosts } from "./gitHosts.ts";
import {
  isOlderThan,
  PANEL_OPEN_TTL_MS,
  PANEL_REFRESH_AGE_MS,
  POLL_TICK_MS,
  prIsDue,
  WARM_INTERVAL_MS,
} from "./prPolling.ts";
import { mapWithConcurrency, messageOf, type Logger } from "./util.ts";

// The PR poller, on any git host: which PR links are due (prPolling.ts), batching them per host and repository, backing
// off a PR or a host that failed, and never reading one link twice at once. Each host reads its PRs with readSnapshots.

/** Requests in flight at once, polite to a host's secondary limits. */
const POLL_CONCURRENCY = 4;
/** PRs per read; GitHub caps a query's cost, and a large check list is costly. */
const BATCH_SIZE = 25;

/** The poller's `debug` line is optional so a logger that only warns still fits. */
export type PollLogger = Logger & Partial<Pick<Console, "debug">>;

export interface PrPollerServices {
  links: Pick<LinksService, "listByKind" | "get" | "setSnapshot">;
  settings: Pick<SettingsService, "get">;
}

type PrLink = Extract<TaskLink, { kind: "pr" }>;
export type RefPrLink = PrLink & { ref: NonNullable<PrLink["ref"]> };

export interface PrPoller {
  /**
   * One poll over the PR links that are due: hot ones every 20 s, warm every 2 minutes, merged or closed every 30
   * (`prIsDue`). No-op when polling is off or no host's CLI is signed in. `now` is for tests.
   */
  pollAll(now?: number): Promise<void>;
  /**
   * A task's panel is open: reads its PR links now when the last read is older than 15 s, and polls them hot while
   * the panel keeps asking. No-op when polling is off or no host's CLI is signed in.
   */
  viewTask(taskId: string): Promise<void>;
  /** Reads a PR link that was just added, so it shows its state now rather than at the next poll. Never throws. */
  pollLink(linkId: string): Promise<void>;
  /** Fetches one PR link now. Returns false when no git host serves it. Throws AppError on failure. */
  refresh(link: TaskLink): Promise<boolean>;
  /** Reads a PR link again and stores it, after a merge; with `quiet` a failure is logged, not thrown. */
  reread(link: RefPrLink, opts?: { quiet?: boolean }): Promise<void>;
  start(): void;
  stop(): void;
}

export function createPrPoller(deps: {
  services: () => PrPollerServices;
  hosts: GitHosts;
  log?: PollLogger;
}): PrPoller {
  const { hosts } = deps;
  const log: PollLogger = deps.log ?? console;
  let polling = false;
  const timers: NodeJS.Timeout[] = [];
  /** Last error logged per link (or host), so a persistent failure is logged once. */
  const loggedErrors = new Map<string, string>();
  /** When each task's panel last asked for its PRs, so they're polled hot while it's open. */
  const viewedAt = new Map<string, number>();
  /**
   * When a link, or a host (`host:<name>`), last failed. The poller looks every 20 s, so a PR the host can't find or a
   * host that refused (a rate limit) is left alone for the warm interval rather than asked again each tick.
   */
  const failedAt = new Map<string, number>();
  const backedOff = (key: string, now: number): boolean => now - (failedAt.get(key) ?? -Infinity) < WARM_INTERVAL_MS;

  /** The tag a host's log lines carry: its kind, as `[github]`. */
  const tag = (host: GitHost | null) => `[${host?.kind ?? "git"}]`;

  const logOnce = (host: GitHost | null, key: string, label: string, message: string) => {
    if (loggedErrors.get(key) === message) return;
    loggedErrors.set(key, message);
    log.warn(`${tag(host)} ${label}: ${message}`);
  };

  /** Reads one batch of a repo's PRs and stores what came back. Per-PR failures are logged. */
  const pollBatch = async (host: GitHost, name: string, repo: string, links: readonly RefPrLink[]): Promise<void> => {
    const services = deps.services();
    const results = await host.readSnapshots(
      name,
      repo,
      links.map((l) => l.ref.number),
    );
    links.forEach((link, i) => {
      const result = results[i];
      if (result && !("error" in result)) {
        services.links.setSnapshot(link.id, result);
        loggedErrors.delete(link.id);
        failedAt.delete(link.id);
        return;
      }
      failedAt.set(link.id, Date.now());
      logOnce(host, link.id, link.url, result?.error ?? "PR not found");
    });
  };

  /** Links being read now, so a poll, a panel opening and a new link never fetch one at once and race to store it. */
  const inFlight = new Set<string>();

  /** Reads the links in batches per host and repo, and returns how many reads went out. */
  const pollLinks = async (all: readonly { link: RefPrLink; host: GitHost }[]): Promise<number> => {
    const links = all.filter((l) => !inFlight.has(l.link.id));
    for (const { link } of links) inFlight.add(link.id);
    try {
      return await pollBatches(links);
    } finally {
      for (const { link } of links) inFlight.delete(link.id);
    }
  };

  const pollBatches = async (links: readonly { link: RefPrLink; host: GitHost }[]): Promise<number> => {
    const groups = new Map<string, { host: GitHost; name: string; repo: string; links: RefPrLink[] }>();
    for (const { link, host } of links) {
      const key = `${link.ref.host}\n${link.ref.repo.toLowerCase()}`;
      const group = groups.get(key) ?? { host, name: link.ref.host, repo: link.ref.repo, links: [] };
      group.links.push(link);
      groups.set(key, group);
    }
    const batches = [...groups.values()].flatMap((g) =>
      chunk(g.links, BATCH_SIZE).map((batch) => ({ ...g, links: batch })),
    );
    /** Hosts that answered with a rate limit or a refused credential this poll: skip their other batches. */
    const stoppedHosts = new Set<string>();
    let reads = 0;
    await mapWithConcurrency(batches, POLL_CONCURRENCY, async (batch) => {
      if (stoppedHosts.has(batch.name)) return;
      reads += 1;
      try {
        await pollBatch(batch.host, batch.name, batch.repo, batch.links);
        loggedErrors.delete(`host:${batch.name}`);
        failedAt.delete(`host:${batch.name}`);
      } catch (error) {
        if (isHostWideError(error)) {
          stoppedHosts.add(batch.name);
          failedAt.set(`host:${batch.name}`, Date.now());
          logOnce(batch.host, `host:${batch.name}`, batch.name, messageOf(error));
          return;
        }
        for (const link of batch.links) {
          failedAt.set(link.id, Date.now());
          logOnce(batch.host, link.id, link.url, messageOf(error));
        }
      }
    });
    return reads;
  };

  /**
   * The polled PR links with the host serving each, or null when polling is off or no host's CLI is signed in. Links
   * that failed lately and links on a host that refused are left out, so no path (the tick, a panel opening, a new
   * link) asks again within the back-off.
   */
  const pollableLinks = async (now: number): Promise<{ link: RefPrLink; host: GitHost }[] | null> => {
    const services = deps.services();
    if (!services.settings.get().githubPolling) return null;
    const statuses = await Promise.all(hosts.all().map((h) => h.ensureStatus()));
    if (!statuses.some((s) => s.authenticated)) return null;
    const links = services.links.listByKind("pr").flatMap((l) => {
      if (l.kind !== "pr" || l.ref === null) return [];
      const host = hosts.forHost(l.ref.host);
      return host && host.status().authenticated && host.reaches(l.ref.host) ? [{ link: l as RefPrLink, host }] : [];
    });
    const ids = new Set(links.map((l) => l.link.id));
    for (const key of failedAt.keys()) {
      if (!backedOff(key, now) || !(key.startsWith("host:") || ids.has(key))) failedAt.delete(key);
    }
    return links.filter((l) => !backedOff(l.link.id, now) && !backedOff(`host:${l.link.ref.host}`, now));
  };

  const isViewed = (taskId: string, now: number): boolean =>
    now - (viewedAt.get(taskId) ?? -Infinity) < PANEL_OPEN_TTL_MS;

  const pollAll = async (now = Date.now()): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (const [taskId] of viewedAt) if (!isViewed(taskId, now)) viewedAt.delete(taskId);
      const links = await pollableLinks(now);
      if (!links) return;
      const due = links.filter((l) => prIsDue(l.link, now, isViewed(l.link.taskId, now)));
      if (due.length === 0) return;
      const reads = await pollLinks(due);
      log.debug?.(`[git] polled ${due.length} of ${links.length} PRs in ${reads} reads`);
    } catch (error) {
      log.warn(`[git] poll failed: ${messageOf(error)}`);
    } finally {
      polling = false;
    }
  };

  /** Reads one link now and stores it, ending any back-off. Throws on failure. */
  const readOne = async (host: GitHost, link: RefPrLink): Promise<void> => {
    deps.services().links.setSnapshot(link.id, await host.readSnapshot(link.ref));
    loggedErrors.delete(link.id);
    // A read that worked ends any back-off, so an open panel polls the PR again.
    failedAt.delete(link.id);
    failedAt.delete(`host:${link.ref.host}`);
  };

  return {
    pollAll,
    async pollLink(linkId) {
      try {
        const found = (await pollableLinks(Date.now()))?.find((l) => l.link.id === linkId);
        if (found) await pollLinks([found]);
      } catch (error) {
        log.warn(`[git] couldn't read the new PR link: ${messageOf(error)}`);
      }
    },
    async viewTask(taskId) {
      const now = Date.now();
      viewedAt.set(taskId, now);
      try {
        const links = await pollableLinks(now);
        const stale =
          links?.filter((l) => l.link.taskId === taskId && isOlderThan(l.link, now, PANEL_REFRESH_AGE_MS)) ?? [];
        if (stale.length > 0) await pollLinks(stale);
      } catch (error) {
        log.warn(`[git] panel refresh failed: ${messageOf(error)}`);
      }
    },
    async refresh(link) {
      // Checked before any status read so refreshing a T3 thread or ticket link never spawns a CLI.
      if (link.kind !== "pr" || link.ref === null) return false;
      const host = await hosts.resolve(link.ref.host);
      if (!host) return false;
      await host.requireSignedIn(link.ref.host);
      try {
        await readOne(host, link as RefPrLink);
      } catch (error) {
        throw new AppError("VALIDATION", `Could not fetch PR: ${messageOf(error)}`);
      }
      return true;
    },
    async reread(link, opts) {
      const host = hosts.forHost(link.ref.host);
      if (!host) return;
      try {
        await readOne(host, link);
      } catch (error) {
        if (!opts?.quiet) throw error;
        logOnce(host, link.id, link.url, messageOf(error));
      }
    },
    start() {
      void hosts.checkStatuses().then(() => pollAll());
      timers.push(setInterval(() => void pollAll(), POLL_TICK_MS).unref());
    },
    stop() {
      for (const timer of timers.splice(0)) clearInterval(timer);
    },
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
