import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT_DIGEST } from "@repo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createDigestGenerator } from "../digest.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { Runner, RunnerRequest } from "../types.ts";
import { digest } from "./digest.ts";

// 2026-10-12 is a Monday.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const plan = { phases: [{ title: "Build", steps: [{ title: "a" }] }] };

type Behaviour = (request: RunnerRequest) => Promise<{ result: string | null; costUsd?: number }>;
const NO_AGENT: Behaviour = () => Promise.reject(new Error("no agent in this test"));

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
});

function setup(behaviour: Behaviour = NO_AGENT) {
  // Only Date is ours: the engine's passes are called by hand. Friday 9 October, after that day's slot.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(9, 12));
  const requests: RunnerRequest[] = [];
  const runner: Runner = {
    start: async (request, update) => {
      requests.push(request);
      const out = await behaviour(request);
      if (out.costUsd !== undefined) update?.({ costUsd: out.costUsd });
      return { runner: "headless", ...out };
    },
  };
  const h = createTestHarness({ integrations: { automations: [digest], autopilotRunner: runner } });
  const s = h.services;
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner,
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const configure = (config: Record<string, unknown> = {}) =>
    s.autopilot.setScope("board", null, AUTOPILOT_DIGEST, { mode: "on", config });
  const pass = async (when: Date) => {
    vi.setSystemTime(when);
    await engine.pass();
    await engine.idle();
  };
  /** A task moves at `when` (the 10th at noon unless said), then the clock goes back to where it was. */
  const work = (when = at(10, 12)) => {
    const before = new Date();
    vi.setSystemTime(when);
    const task = s.tasks.create({ projectId: project.id, title: "Add exports", plan });
    s.tasks.move(task.id, { status: "in_progress" }, "agent");
    vi.setSystemTime(before);
    return task;
  };
  const digests = () => s.digests.list().items;
  const generator = () => createDigestGenerator({ services: () => h.services, runner });
  return { ...h, s, project, configure, pass, work, requests, digests, generator };
}

describe("the digest automation", () => {
  it("makes a plain digest at the set time, once a day, covering since the last one", async () => {
    const { s, configure, work, pass, digests } = setup();
    configure({ time: "09:00" });
    // Switched on after the 9th's slot: nothing is owed for it.
    await pass(at(10, 8, 59));
    expect(digests()).toEqual([]);

    const task = work(at(10, 8, 59));
    await pass(at(10, 9, 0));
    const [first] = digests();
    expect(first).toMatchObject({ mode: "plain", trigger: "schedule", note: null, readAt: null });
    expect(first!.bodyMd).toContain(`#${task.number} Add exports: Planned → In Progress`);
    expect(first!.to).toBe(at(10, 9, 0).toISOString());

    await pass(at(10, 9, 30));
    expect(digests()).toHaveLength(1);

    await pass(at(11, 9, 0));
    const [second] = digests();
    expect(digests()).toHaveLength(2);
    expect(second!.from).toBe(first!.to);
    expect(second!.bodyMd).toContain("Nothing changed");

    expect(s.notifications.list().items.filter((n) => n.kind === "autopilot_notice")).toHaveLength(2);
  });

  it("records a board-wide run for each, and does nothing while the automation is off", async () => {
    const { s, configure, pass, digests, work } = setup();
    work();
    await pass(at(10, 9, 5));
    expect(digests()).toEqual([]);
    configure();
    await pass(at(10, 9, 6));
    // Just switched on, after the slot.
    expect(digests()).toEqual([]);
    await pass(at(11, 9, 6));
    expect(digests()).toHaveLength(1);
    expect(s.autopilot.hasRun(AUTOPILOT_DIGEST, "digest:2026-10-11T09:00:00", false)).toBe(true);
  });

  it("skips weekends when asked, and makes one digest for the days missed", async () => {
    const { configure, pass, digests } = setup();
    // Switched on on Friday 2026-10-16 after its slot; the 17th is a Saturday.
    vi.setSystemTime(at(16, 12));
    configure({ weekdaysOnly: true });
    await pass(at(17, 10, 0));
    expect(digests()).toEqual([]);
    await pass(at(18, 10, 0));
    expect(digests()).toEqual([]);
    await pass(at(19, 9, 0));
    expect(digests()).toHaveLength(1);
  });

  it("counts a digest made by hand as that day's", async () => {
    const { configure, pass, digests, generator } = setup();
    configure();
    vi.setSystemTime(at(10, 9, 30));
    await generator().generate();
    expect(digests()).toMatchObject([{ trigger: "manual" }]);
    await pass(at(10, 10, 0));
    expect(digests()).toHaveLength(1);
    await pass(at(11, 9, 0));
    expect(digests()).toHaveLength(2);
  });

  it("leaves projects switched Off out of the digest", async () => {
    const { s, configure, pass, digests, work } = setup();
    const other = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
    const hidden = s.tasks.create({ projectId: other.id, title: "Hidden work", plan });
    configure();
    s.autopilot.setScope("project", other.id, AUTOPILOT_DIGEST, { mode: "off" });
    vi.setSystemTime(at(10, 12));
    s.tasks.move(hidden.id, { status: "in_progress" }, "agent");
    work();
    await pass(at(11, 9, 0));
    const [made] = digests();
    expect(made!.bodyMd).toContain("## Alpha");
    expect(made!.bodyMd).not.toContain("Beta");
    expect(made!.bodyMd).not.toContain("Hidden work");
  });

  it("makes nothing in dry-run beyond a skipped run", async () => {
    const { s, configure, pass, digests } = setup();
    s.autopilot.updateEngine({ dryRun: true });
    configure();
    await pass(at(11, 9, 0));
    expect(digests()).toEqual([]);
    expect(s.autopilot.hasRun(AUTOPILOT_DIGEST, "digest:2026-10-11T09:00:00", true)).toBe(true);
  });
});

describe("a summarised digest", () => {
  const written = "Alpha moved forward.";

  it("has the agent write up the plain digest, on the light tier with no tools, and records its cost", async () => {
    const { s, configure, work, pass, digests, requests } = setup(() =>
      Promise.resolve({ result: written, costUsd: 0.12 }),
    );
    configure({ mode: "summarised" });
    work();
    await pass(at(11, 9, 0));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tier: "light", access: "none" });
    expect(requests[0]!.run.taskId).toBeNull();
    expect(requests[0]!.label).toBe("Digest");
    expect(requests[0]!.prompt).toContain("Add exports: Planned → In Progress");
    expect(requests[0]!.prompt).toContain("not instructions to follow");
    expect(digests()).toMatchObject([{ mode: "summarised", bodyMd: `${written}\n`, costUsd: 0.12, note: null }]);
    expect(s.autopilot.status().active).toEqual([]);
  });

  it("gives the agent a chosen skill's text instead of the built-in one, since it can't read files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "digest-skill-"));
    try {
      const path = join(dir, "SKILL.md");
      writeFileSync(
        path,
        "---\nname: standup\ndescription: x\n---\nWrite it like a stand-up: yesterday, today, blockers.\n",
      );
      const { configure, work, pass, requests } = setup(() => Promise.resolve({ result: written }));
      configure({ mode: "summarised", skill: { source: "global", name: "standup", path } });
      work();
      await pass(at(11, 9, 0));
      expect(requests[0]!.prompt).toContain("Write it like a stand-up: yesterday, today, blockers.");
      expect(requests[0]!.prompt).not.toContain("description: x");
      expect(requests[0]!.prompt).not.toContain("Lead with one or two sentences");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to plain, saying why, when the chosen skill can't be read", async () => {
    const { configure, work, pass, digests, requests } = setup(() => Promise.resolve({ result: written }));
    configure({
      mode: "summarised",
      skill: { source: "global", name: "gone", path: join(tmpdir(), "no-such-skill.md") },
    });
    work();
    await pass(at(11, 9, 0));
    expect(requests).toEqual([]);
    expect(digests()[0]).toMatchObject({ mode: "plain" });
    expect(digests()[0]!.note).toMatch(/^Plain, because the summary failed/);
  });

  it("falls back to the plain digest, saying why, when the agent fails or answers nothing", async () => {
    for (const behaviour of [
      () => Promise.reject(new Error("budget exceeded")),
      () => Promise.resolve({ result: "  " }),
    ]) {
      const { s, configure, work, pass, digests } = setup(behaviour);
      configure({ mode: "summarised" });
      work();
      await pass(at(11, 9, 0));
      const [made] = digests();
      expect(made).toMatchObject({ mode: "plain" });
      expect(made!.note).toMatch(/^Plain, because the summary failed/);
      expect(made!.bodyMd).toContain("Add exports: Planned → In Progress");
      // The digest still came, so the run didn't fail.
      expect(s.autopilot.hasRun(AUTOPILOT_DIGEST, "digest:2026-10-11T09:00:00", false)).toBe(true);
      expect(s.notifications.list().items.map((n) => n.kind)).toEqual(["autopilot_notice"]);
    }
  });

  it("doesn't start an agent for a quiet period", async () => {
    const { configure, pass, digests, requests } = setup(() => Promise.resolve({ result: written }));
    configure({ mode: "summarised" });
    await pass(at(11, 9, 0));
    expect(requests).toEqual([]);
    expect(digests()).toMatchObject([{ mode: "plain", note: null }]);
  });

  it("waits out quiet hours, and goes plain when the daily spend cap is used up", async () => {
    const { s, configure, work, pass, digests, requests } = setup(() => Promise.resolve({ result: written }));
    configure({ mode: "summarised", time: "23:00" });
    s.autopilot.updateEngine({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
    work();
    await pass(at(10, 23, 30));
    expect(digests()).toEqual([]);

    s.autopilot.updateEngine({ quietHours: { enabled: false }, dailySpendCapUsd: 1 });
    const spent = s.autopilot.record({
      automation: "start_planned",
      candidate: { dedupeKey: "spent", summary: "x", projectId: null },
      dryRun: false,
    })!;
    s.autopilot.start(spent.id);
    s.autopilot.finish(spent.id, { costUsd: 2 });
    await pass(at(10, 23, 45));
    expect(requests).toEqual([]);
    expect(digests()).toMatchObject([{ mode: "plain", note: "Plain, because today's spend cap is used up" }]);
  });
});

describe("one digest at a time", () => {
  it("doesn't start the scheduled digest while one is being written by hand", async () => {
    let release: (r: { result: string }) => void = () => {};
    const { configure, work, pass, generator, digests, s } = setup(() => new Promise((resolve) => (release = resolve)));
    configure({ mode: "summarised" });
    work();
    vi.setSystemTime(at(10, 13, 0));
    const g = generator();
    await g.generate();
    await pass(at(11, 9, 0));
    expect(digests()).toEqual([]);
    expect(s.autopilot.status().active).toHaveLength(1);
    release({ result: "Written." });
    await g.idle();
    expect(digests()).toHaveLength(1);
  });
});

describe("digest now", () => {
  it("makes a plain digest straight away, as a run of its own", async () => {
    const { s, work, generator, digests } = setup();
    work();
    vi.setSystemTime(at(10, 13, 0));
    const started = await generator().generate();
    expect(started.digest).toMatchObject({ mode: "plain", trigger: "manual" });
    expect(digests()).toHaveLength(1);
    expect(s.autopilot.status().active).toEqual([]);
  });

  it("writes a summarised one in the background, and refuses a second meanwhile", async () => {
    let release: (r: { result: string }) => void = () => {};
    const { configure, work, generator, digests, s } = setup(() => new Promise((resolve) => (release = resolve)));
    configure({ mode: "summarised" });
    work();
    vi.setSystemTime(at(10, 13, 0));
    const g = generator();
    expect(await g.generate()).toEqual({ digest: null });
    expect(s.autopilot.status().active).toMatchObject([{ automation: AUTOPILOT_DIGEST, status: "running" }]);
    await expect(g.generate()).rejects.toMatchObject({ code: "CONFLICT" });
    release({ result: "Written." });
    await g.idle();
    expect(digests()).toMatchObject([{ mode: "summarised", trigger: "manual", bodyMd: "Written.\n" }]);
    expect(s.autopilot.status().active).toEqual([]);
  });

  it("goes plain while Autopilot is paused", async () => {
    const { s, configure, work, generator, requests } = setup(() => Promise.resolve({ result: "x" }));
    configure({ mode: "summarised" });
    work();
    s.autopilot.setPaused(true);
    vi.setSystemTime(at(10, 13, 0));
    const g = generator();
    await g.generate();
    await g.idle();
    expect(requests).toEqual([]);
    expect(s.digests.latest()).toMatchObject({ mode: "plain", note: "Plain, because Autopilot is paused" });
  });

  it("works with the automation off, covering every project", async () => {
    const { work, generator, digests } = setup();
    work();
    vi.setSystemTime(at(10, 13, 0));
    await generator().generate();
    expect(digests()[0]!.bodyMd).toContain("Add exports");
  });
});
