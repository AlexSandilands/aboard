import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND, prMergeAction } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../context.ts";
import { SCENARIOS, seedDatabase, type ScenarioName } from "./seeds.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seeded(scenario: ScenarioName) {
  const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-seed-`));
  dirs.push(dir);
  const dbPath = join(dir, "data.sqlite");
  seedDatabase(dbPath, scenario, { workspaceRoot: dir });
  const ctx = createContext({
    dbPath,
    port: 0,
    webPort: 0,
    token: null,
    t3Home: "/nonexistent",
    pollers: false,
    userHome: "/nonexistent",
    sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
  });
  const tasks = ctx.services.tasks.summaries({ includeArchived: true });
  const details = tasks.map((t) => ctx.services.tasks.detail(t.id));
  const runs = tasks.flatMap((t) => ctx.services.autopilot.runsForTask(t.id));
  const suggestions = ctx.services.suggestions.list();
  ctx.db.close();
  return { tasks, details, runs, suggestions };
}

describe("seed scenarios", () => {
  // The stats scenario seeds twelve weeks of history and took 19 s on a busy Windows runner, over the default.
  it.each(Object.keys(SCENARIOS) as ScenarioName[])(
    "%s seeds a fresh data dir",
    (scenario) => {
      expect(seeded(scenario).tasks.length).toBeGreaterThan(5);
    },
    60_000,
  );

  it("basic fills every column, with more than five Done and an archived card", () => {
    const { tasks, details } = seeded("basic");
    expect(new Set(tasks.map((t) => t.status))).toEqual(
      new Set(["backlog", "planned", "in_progress", "review", "done"]),
    );
    expect(tasks.filter((t) => t.status === "done" && !t.archivedAt).length).toBeGreaterThan(5);
    expect(tasks.some((t) => t.archivedAt)).toBe(true);
    expect(tasks.some((t) => t.stepStatuses.includes("blocked"))).toBe(true);
    expect(details.some((t) => t.status === "backlog" && t.phases.length > 0)).toBe(true);
    const epic = details.find((t) => t.title === "One-page checkout");
    expect(new Set(epic?.children.map((c) => c.status))).toEqual(new Set(["backlog", "in_progress", "review"]));
    expect(epic?.status).toBe("backlog");
    const finished = details.filter((t) => t.kind === "epic" && t.status === "done");
    expect(finished.length).toBeGreaterThan(1);
    expect(finished.every((t) => t.children.length > 0)).toBe(true);
  });

  it("basic has a dependency chain across projects, with a finished blocker", () => {
    const { tasks } = seeded("basic");
    const blocked = tasks.filter((t) => t.blocked);
    expect(blocked.length).toBeGreaterThanOrEqual(3);
    expect(new Set(blocked.map((t) => t.projectId)).size).toBeGreaterThan(1);
    expect(tasks.some((t) => t.blockedBy.some((b) => b.status === "done"))).toBe(true);
    expect(tasks.some((t) => t.blocks.length > 0 && t.blockedBy.length > 0)).toBe(true);
  });

  it("review covers every round status and finding severity", () => {
    const { details } = seeded("review");
    const rounds = details.flatMap((t) => t.reviews);
    expect(new Set(rounds.map((r) => r.status))).toEqual(
      new Set(["pending", "running", "stalled", "submitted", "failed"]),
    );
    const findings = rounds.flatMap((r) => r.findings);
    expect(new Set(findings.map((f) => f.severity))).toEqual(new Set(["blocking", "major", "minor", "nit"]));
    expect(new Set(findings.map((f) => f.status))).toEqual(new Set(["open", "fixed", "wont_fix"]));
  });

  it("stats spreads finished tasks and runs over the weeks", async () => {
    const dir = mkdtempSync(join(tmpdir(), `${BRAND.id}-seed-`));
    dirs.push(dir);
    const dbPath = join(dir, "data.sqlite");
    seedDatabase(dbPath, "stats", { workspaceRoot: dir });
    const ctx = createContext({
      dbPath,
      port: 0,
      webPort: 0,
      token: null,
      t3Home: "/nonexistent",
      pollers: false,
      userHome: "/nonexistent",
      sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
    });
    const stats = await ctx.services.stats.weekly(12);
    // The run history page has Orchestrate and custom-automation runs with answers across projects to page through.
    const agentRuns = ctx.services.autopilot.history({ automation: "orchestrate", limit: 100 });
    ctx.db.close();
    expect(agentRuns.runs.length).toBeGreaterThan(30);
    expect(new Set(agentRuns.runs.map((r) => r.projectId)).size).toBeGreaterThan(1);
    expect(agentRuns.runs.some((r) => r.output !== null)).toBe(true);
    const completed = stats.series.tasks_completed!;
    expect(completed.values.filter((n) => (n ?? 0) > 0).length).toBeGreaterThan(8);
    expect(stats.series["cycle_time.in_progress_to_done"]!.total).toBeGreaterThan(0);
    expect(stats.series["autopilot.runs"]!.total).toBeGreaterThan(40);
    // Seeding plus the stats read (which spawns git for commits) took 17 s on a busy Windows runner, over the default.
  }, 60_000);

  it("threads stores PR and T3 thread snapshots", () => {
    const links = seeded("threads").details.flatMap((t) => t.links);
    const snapshotStates = links.flatMap((l) =>
      l.kind === "pr" && l.snapshot
        ? [l.snapshot.state]
        : l.kind === "t3_thread" && l.snapshot
          ? [l.snapshot.status]
          : [],
    );
    expect(snapshotStates).toEqual(expect.arrayContaining(["open", "draft", "merged", "closed", "working", "input"]));
    expect(links.some((l) => l.kind === "pr" && !l.snapshot)).toBe(true);
  });

  it("threads has an agent session in each status, and one beside a T3 thread", () => {
    const { details } = seeded("threads");
    const sessions = details.flatMap((t) => t.links.filter((l) => l.kind === "agent_session"));
    expect(sessions.map((l) => (l.kind === "agent_session" ? (l.snapshot?.status ?? null) : null))).toEqual(
      expect.arrayContaining(["busy", "idle", "not_running", "running", "finished", "failed", null]),
    );
    const withThread = details.find((t) => t.title === "Session inside a T3 thread");
    expect(withThread?.links.map((l) => l.kind).sort()).toEqual(["agent_session", "t3_thread"]);
  });

  it("threads has tasks with many sessions, with and without a T3 thread", () => {
    const { details } = seeded("threads");
    const kinds = (title: string) =>
      details.find((t) => t.title === title)?.links.filter((l) => l.kind === "agent_session").length;
    expect(kinds("Many sessions, no T3 thread")).toBe(5);
    expect(kinds("Many sessions beside a T3 thread")).toBe(4);
    const thread = details
      .find((t) => t.title === "Many sessions beside a T3 thread")
      ?.links.find((l) => l.kind === "t3_thread");
    expect(thread?.kind === "t3_thread" && thread.snapshot?.title).toBe("Build the cart");
  });

  it("threads offers every merge control on Review PRs", () => {
    const { details } = seeded("threads");
    const actions = details.flatMap((t) =>
      t.links.flatMap((l) => (l.kind === "pr" ? [prMergeAction(t.status, l.snapshot)] : [])),
    );
    expect(actions).toEqual(expect.arrayContaining(["merge", "auto", "armed", null]));
    const hosts = details.flatMap((t) => t.links.flatMap((l) => (l.kind === "pr" && l.ref ? [l.ref.host] : [])));
    expect(hosts).toContain("github.example.com");
  });

  it("showcase mixes labels, PRs, threads, review and a blocked step across projects", () => {
    const { tasks, details } = seeded("showcase");
    expect(new Set(tasks.map((t) => t.projectId)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(tasks.map((t) => t.status))).toEqual(
      new Set(["backlog", "planned", "in_progress", "review", "done"]),
    );
    expect(tasks.some((t) => t.labels.length > 0)).toBe(true);
    expect(tasks.some((t) => t.stepStatuses.includes("blocked"))).toBe(true);
    const kinds = details.flatMap((t) => t.links.map((l) => l.kind));
    expect(kinds).toEqual(expect.arrayContaining(["pr", "t3_thread", "ticket"]));
    expect(details.some((t) => t.reviews.some((r) => r.findings.some((f) => f.severity === "blocking")))).toBe(true);
  });

  it("showcase has suggested changes waiting for the user, and one already rejected", () => {
    const { suggestions } = seeded("showcase");
    expect(suggestions.open).toBe(2);
    expect(suggestions.items.map((i) => [i.target.kind, i.status, i.current])).toEqual([
      ["automation", "open", "same"],
      ["builtin", "open", "same"],
      ["builtin", "rejected", null],
    ]);
  });

  it("showcase has Autopilot history: a finished run, a failed one that needs attention, and a dry run", () => {
    const { runs } = seeded("showcase");
    expect(runs.some((r) => r.status === "succeeded" && r.threadUrl && r.costUsd)).toBe(true);
    expect(runs.some((r) => r.status === "failed" && r.needsAttention && r.error)).toBe(true);
    expect(runs.some((r) => r.dryRun && r.status === "skipped")).toBe(true);
  });
});
