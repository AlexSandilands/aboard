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
  });
  const tasks = ctx.services.tasks.summaries({ includeArchived: true });
  const details = tasks.map((t) => ctx.services.tasks.detail(t.id));
  ctx.db.close();
  return { tasks, details };
}

describe("seed scenarios", () => {
  it.each(Object.keys(SCENARIOS) as ScenarioName[])("%s seeds a fresh data dir", (scenario) => {
    expect(seeded(scenario).tasks.length).toBeGreaterThan(5);
  });

  it("basic fills every column, with more than five Done and an archived card", () => {
    const { tasks, details } = seeded("basic");
    expect(new Set(tasks.map((t) => t.status))).toEqual(
      new Set(["backlog", "planned", "in_progress", "review", "done"]),
    );
    expect(tasks.filter((t) => t.status === "done" && !t.archivedAt).length).toBeGreaterThan(5);
    expect(tasks.some((t) => t.archivedAt)).toBe(true);
    expect(tasks.some((t) => t.stepStatuses.includes("blocked"))).toBe(true);
    expect(details.some((t) => t.status === "backlog" && t.phases.length > 0)).toBe(true);
    const epic = details.find((t) => t.kind === "epic" && t.children.length > 0);
    expect(new Set(epic?.children.map((c) => c.status))).toEqual(new Set(["backlog", "in_progress", "review"]));
    expect(epic?.status).toBe("backlog");
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
    expect(kinds).toEqual(expect.arrayContaining(["pr", "t3_thread", "jira"]));
    expect(details.some((t) => t.reviews.some((r) => r.findings.some((f) => f.severity === "blocking")))).toBe(true);
  });
});
