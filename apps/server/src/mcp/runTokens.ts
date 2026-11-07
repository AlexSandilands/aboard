import { createHash, randomBytes } from "node:crypto";
import { BRAND, brandEnv, type PrRef } from "@repo/contracts";

// The credentials of board-served run tools (docs/decisions/0013-board-served-run-tools.md). A headless run gets a
// random token bound to the run, its tool set and its target; `/mcp/run`, called with it, serves that set for that target and
// nothing else. Tokens live only in memory, are kept by their hash, and are never logged.

/** The MCP server's name in a run's config: its tools reach the agent as `mcp__<name>__<tool>` in Claude Code. */
export const RUN_SERVER_NAME = `${BRAND.id}-run`;

/** The environment variable a CLI that reads the run's token from its environment (Codex) is given it in. */
export const RUN_TOKEN_ENV = brandEnv("RUN_TOKEN");

/** The tool sets a run can be given, one per kind of operation. */
export type RunToolSet = "prReview" | "repoPrReview";

/** What a run's tools read. Every tool of the set is bound to it: none takes a target of its own. */
export type RunTarget = { kind: "pr" } & PrRef;

export interface RunToolScope {
  toolSet: RunToolSet;
  target: RunTarget;
}

/** A live token's grant: what it may read, until when, and the reads its run has already made. */
export interface RunGrant extends RunToolScope {
  runId: string;
  expiresAt: number;
  /** Reads cached for the run's lifetime, so paging a large diff doesn't fetch every file again for each page. */
  cache: Map<string, Promise<unknown>>;
}

/**
 * A token lives no longer than this, whatever the run asked: a run that outlives it (it never should, its timeout is
 * shorter) loses its tools rather than keeping a credential alive.
 */
export const RUN_TOKEN_MAX_TTL_MS = 24 * 60 * 60_000 + 10 * 60_000;

export interface RunTokens {
  /** A new token for the run. `ttlMs` is capped at RUN_TOKEN_MAX_TTL_MS. */
  mint(runId: string, scope: RunToolScope, ttlMs: number): { token: string; revoke: () => void };
  /** The grant of a live token, or null for an unknown, revoked or expired one. */
  resolve(token: string): RunGrant | null;
  /** Revokes every token of the run. */
  revokeRun(runId: string): void;
  /** How many tokens are live, for tests. */
  size(): number;
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export function createRunTokens(deps: { now?: () => number } = {}): RunTokens {
  const now = deps.now ?? Date.now;
  const grants = new Map<string, RunGrant>();

  const sweep = () => {
    const at = now();
    for (const [key, grant] of grants) if (grant.expiresAt <= at) grants.delete(key);
  };

  return {
    mint(runId, scope, ttlMs) {
      sweep();
      const token = randomBytes(32).toString("base64url");
      const key = digest(token);
      const ttl = Math.min(Math.max(0, ttlMs), RUN_TOKEN_MAX_TTL_MS);
      grants.set(key, {
        runId,
        toolSet: scope.toolSet,
        target: scope.target,
        expiresAt: now() + ttl,
        cache: new Map(),
      });
      return { token, revoke: () => grants.delete(key) };
    },
    resolve(token) {
      if (!token) return null;
      const key = digest(token);
      const grant = grants.get(key);
      if (!grant) return null;
      if (grant.expiresAt <= now()) {
        grants.delete(key);
        return null;
      }
      return grant;
    },
    revokeRun(runId) {
      for (const [key, grant] of grants) if (grant.runId === runId) grants.delete(key);
    },
    size() {
      sweep();
      return grants.size;
    },
  };
}
