import type { PrSnapshot, TaskLink } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  COLD_INTERVAL_MS,
  POLL_TICK_MS,
  isOlderThan,
  PANEL_REFRESH_AGE_MS,
  prIsDue,
  prTier,
  RECENT_MS,
  WARM_INTERVAL_MS,
} from "./prPolling.ts";

type PrLink = Extract<TaskLink, { kind: "pr" }>;

const NOW = Date.parse("2026-10-18T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const snapshot = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  state: "open",
  title: "A PR",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/x",
  updatedAt: ago(RECENT_MS * 3),
  ...over,
});

const link = (over: { snapshot?: PrSnapshot | null; syncedAt?: string | null; createdAt?: string } = {}): PrLink => ({
  id: "l1",
  taskId: "t1",
  kind: "pr",
  url: "https://github.com/o/r/pull/1",
  label: null,
  syncedAt: ago(0),
  createdAt: ago(RECENT_MS * 3),
  ref: { host: "github.com", repo: "o/r", number: 1 },
  snapshot: snapshot(),
  ...over,
});

describe("prTier", () => {
  it("reads a PR never fetched, one with pending checks, a recent one and a viewed one hot", () => {
    expect(prTier(link({ snapshot: null }), NOW, false)).toBe("hot");
    expect(prTier(link({ snapshot: snapshot({ checks: "pending" }) }), NOW, false)).toBe("hot");
    expect(prTier(link({ snapshot: snapshot({ optionalChecks: { pending: 1, failing: 0 } }) }), NOW, false)).toBe(
      "hot",
    );
    expect(prTier(link({ snapshot: snapshot({ optionalChecks: { pending: 0, failing: 2 } }) }), NOW, false)).toBe(
      "warm",
    );
    expect(prTier(link({ createdAt: ago(RECENT_MS / 2) }), NOW, false)).toBe("hot");
    expect(prTier(link({ snapshot: snapshot({ updatedAt: ago(RECENT_MS / 2) }) }), NOW, false)).toBe("hot");
    expect(prTier(link(), NOW, true)).toBe("hot");
  });

  it("reads other open and draft PRs warm", () => {
    expect(prTier(link(), NOW, false)).toBe("warm");
    expect(prTier(link({ snapshot: snapshot({ state: "draft", checks: "failing" }) }), NOW, false)).toBe("warm");
    expect(prTier(link({ snapshot: snapshot({ updatedAt: null }) }), NOW, false)).toBe("warm");
  });

  it("reads merged and closed PRs cold, even when someone is looking", () => {
    expect(prTier(link({ snapshot: snapshot({ state: "merged" }) }), NOW, false)).toBe("cold");
    expect(prTier(link({ snapshot: snapshot({ state: "closed", checks: "pending" }) }), NOW, true)).toBe("cold");
  });
});

describe("prIsDue", () => {
  it("is due once the tier's interval has passed since the last read, a little early", () => {
    const hot = link({ snapshot: snapshot({ checks: "pending" }) });
    expect(prIsDue({ ...hot, syncedAt: ago(POLL_TICK_MS / 2) }, NOW, false)).toBe(false);
    expect(prIsDue({ ...hot, syncedAt: ago(POLL_TICK_MS - 1_000) }, NOW, false)).toBe(true);
    expect(prIsDue({ ...link(), syncedAt: ago(WARM_INTERVAL_MS - 10_000) }, NOW, false)).toBe(false);
    expect(prIsDue({ ...link(), syncedAt: ago(WARM_INTERVAL_MS) }, NOW, false)).toBe(true);
    const merged = link({ snapshot: snapshot({ state: "merged" }) });
    expect(prIsDue({ ...merged, syncedAt: ago(WARM_INTERVAL_MS * 2) }, NOW, false)).toBe(false);
    expect(prIsDue({ ...merged, syncedAt: ago(COLD_INTERVAL_MS) }, NOW, false)).toBe(true);
  });

  it("is always due when never read", () => {
    expect(prIsDue(link({ syncedAt: null }), NOW, false)).toBe(true);
    expect(prIsDue(link({ syncedAt: null, snapshot: snapshot({ state: "merged" }) }), NOW, false)).toBe(true);
  });
});

describe("isOlderThan", () => {
  it("compares the last read with an age, counting no read as old", () => {
    expect(isOlderThan(link({ syncedAt: ago(PANEL_REFRESH_AGE_MS / 3) }), NOW, PANEL_REFRESH_AGE_MS)).toBe(false);
    expect(isOlderThan(link({ syncedAt: ago(PANEL_REFRESH_AGE_MS * 2) }), NOW, PANEL_REFRESH_AGE_MS)).toBe(true);
    expect(isOlderThan(link({ syncedAt: null }), NOW, PANEL_REFRESH_AGE_MS)).toBe(true);
  });
});
