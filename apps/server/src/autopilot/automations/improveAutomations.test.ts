import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTOPILOT_ACTOR, BRAND, BUILTIN_IMPROVE_SKILL_BODY, type Suggestion } from "@repo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "../engine.ts";
import type { RunnerRequest } from "../types.ts";
import { AUTOPILOT_IMPROVE, IMPROVE_DENIED_TOOLS, improveAutomations } from "./improveAutomations.ts";

const engines: AutopilotEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

const DAY_MS = 24 * 3_600_000;

/** `onRun` is what the fake agent does while it runs, such as writing suggestions. */
type Services = ReturnType<typeof createTestHarness>["services"];

/** What the board records the run's writes under: the runner pins it in the MCP config. */
const actorIn = (request: RunnerRequest): string => request.boardActor!;

function setup(onRun: (s: Services, request: RunnerRequest) => void = () => {}, fail = false) {
  const home = mkdtempSync(join(tmpdir(), "improve-home-"));
  const h = createTestHarness({ userHome: home, integrations: { automations: [improveAutomations] } });
  const requests: RunnerRequest[] = [];
  // Eight days on, so a weekly slot has come whatever today is, and was after the switch-on.
  let later = 8 * DAY_MS;
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: {
      start: (request) => {
        requests.push(request);
        onRun(h.services, request);
        if (fail) return Promise.reject(new Error("out of budget"));
        return Promise.resolve({ runner: "headless", result: null, output: { summary: "audited", handover: "next" } });
      },
    },
    now: () => new Date(Date.now() + later),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const withTask = () => s.tasks.create({ projectId: project.id, title: "Something that happened" });
  const turnOn = (config?: Record<string, unknown>) =>
    s.autopilot.setScope("project", project.id, AUTOPILOT_IMPROVE, {
      mode: "on",
      // A window wide enough that the task made now is inside it when the engine is eight days on.
      config: { lookBackDays: 30, ...config },
    });
  const pass = async () => {
    await engine.pass();
    await engine.idle();
  };
  const runs = () => s.autopilot.runsForProject(project.id).filter((r) => r.automation === AUTOPILOT_IMPROVE);
  return { ...h, s, home, project, withTask, turnOn, pass, runs, requests, setLater: (ms: number) => (later = ms) };
}

describe("Improve automations", () => {
  it("is in the Upkeep group, weekly, and starts nothing until switched on", async () => {
    const { s, withTask, pass, requests, runs } = setup();
    expect(improveAutomations).toMatchObject({ group: "upkeep", needsAgent: true, epicScope: false });
    withTask();
    await pass();
    expect(requests).toHaveLength(0);
    expect(runs()).toHaveLength(0);
    expect(s.autopilot.automations().some((a) => a.key === AUTOPILOT_IMPROVE)).toBe(true);
  });

  it("runs once for a weekly slot, with the skill in the prompt and the window and cap filled in", async () => {
    const { withTask, turnOn, pass, requests, runs } = setup();
    withTask();
    turnOn({ lookBackDays: 14, maxSuggestions: 2 });
    await pass();
    await pass();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({
      operation: "improve",
      access: "read-only",
      untrustedInput: true,
      boardTools: true,
    });
    expect(request.prompt).toContain(BUILTIN_IMPROVE_SKILL_BODY);
    expect(request.prompt).toContain('since "14d"');
    expect(request.prompt).toContain('workspacePath "/work/alpha"');
    expect(request.prompt).toContain("at most 2 changes");
    expect(runs()).toMatchObject([{ status: "succeeded", summary: "Audited Alpha: no suggestions" }]);
  });

  it("finds nothing to run in a project with no tasks, or before its first slot after the switch-on", async () => {
    const { withTask, turnOn, pass, requests, setLater } = setup();
    turnOn();
    await pass();
    expect(requests).toHaveLength(0);
    withTask();
    // Not a week on yet: switching it on doesn't backfill the weeks before.
    setLater(60_000);
    await pass();
    expect(requests).toHaveLength(0);
  });

  it("can write suggestions but can't touch tasks: every other board tool is denied", () => {
    const denied = (tool: string) => IMPROVE_DENIED_TOOLS.includes(`mcp__${BRAND.id}__${tool}`);
    for (const tool of [
      "suggest_change",
      "get_editable_prompt",
      "get_session_transcript",
      "board_activity",
      "get_task",
    ]) {
      expect(denied(tool)).toBe(false);
    }
    for (const tool of [
      "update_task",
      "move_task",
      "add_to_backlog",
      "create_task",
      "merge_task_pr",
      "set_plan",
      "link",
      "social_post",
      "social_read",
    ]) {
      expect(denied(tool)).toBe(true);
    }
  });

  it("fails with the skill's name when a chosen skill can't be read, and runs no agent", async () => {
    const { withTask, turnOn, pass, requests, runs } = setup();
    withTask();
    turnOn({ skill: { source: "global", name: "my-improve", path: "/nowhere/my-improve/SKILL.md" } });
    await pass();
    expect(requests).toHaveLength(0);
    const [run] = runs();
    expect(run).toMatchObject({
      status: "failed",
      summary: 'The skill "my-improve" can\'t be read, so nothing was audited',
    });
    expect(run!.error).toContain("Pick another skill, or Built-in");
  });

  it("follows a chosen skill file instead of the built-in one", async () => {
    const { home, withTask, turnOn, pass, requests } = setup();
    const dir = join(home, ".claude/skills/my-improve");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "---\nname: my-improve\n---\n\nOnly propose changes to the review skill.\n");
    withTask();
    turnOn({ skill: { source: "global", name: "my-improve", path } });
    await pass();
    expect(requests[0]!.prompt).toContain("Only propose changes to the review skill.");
    expect(requests[0]!.prompt).not.toContain(BUILTIN_IMPROVE_SKILL_BODY);
  });

  /** Makes a suggestion for `target` as `actor`, the way the agent's suggest_change does. */
  const suggestFor = (services: Services, target: string, actor: string) => {
    const { hash, text } = services.suggestions.read(target);
    return services.suggestions.suggest({ target, baseHash: hash, proposed: `${text}\nMore.`, rationale: "x" }, actor)
      .suggestion;
  };

  it("keeps this run's first suggestions up to the cap and rejects the rest, leaving other actors' alone", async () => {
    const made: Suggestion[] = [];
    let other: Suggestion | undefined;
    const { s, withTask, turnOn, pass, runs } = setup((services, request) => {
      // Another writer's suggestion lands while the run is going.
      other = suggestFor(services, "builtin:plan", "someone-else");
      made.push(suggestFor(services, "builtin:review", actorIn(request)));
    });
    withTask();
    turnOn({ maxSuggestions: 1 });
    await pass();
    expect(runs()).toMatchObject([{ status: "succeeded", summary: "Audited Alpha: 1 suggestion" }]);
    expect(s.suggestions.get(made[0]!.id).status).toBe("open");
    expect(s.suggestions.get(other!.id).status).toBe("open");

    // Over the cap: a second suggestion by the same run is dropped, with an outcome that isn't the user's verdict.
    const again: Suggestion[] = [];
    const second = setup((services, request) => {
      for (const target of ["builtin:review", "builtin:plan"])
        again.push(suggestFor(services, target, actorIn(request)));
    });
    second.withTask();
    second.turnOn({ maxSuggestions: 1 });
    await second.pass();
    expect(second.runs()).toMatchObject([{ summary: "Audited Alpha: 1 suggestion, dropped 1 past the limits" }]);
    expect(second.s.suggestions.get(again[0]!.id).status).toBe("open");
    expect(second.s.suggestions.get(again[1]!.id)).toMatchObject({
      status: "rejected",
      resolvedBy: AUTOPILOT_ACTOR,
      outcome: expect.stringContaining("Over the limit of 1"),
    });
  });

  it("holds a run that fails to its cap too", async () => {
    const made: Suggestion[] = [];
    const { s, withTask, turnOn, pass, runs } = setup((services, request) => {
      for (const target of ["builtin:review", "builtin:plan"])
        made.push(suggestFor(services, target, actorIn(request)));
    }, true);
    withTask();
    turnOn({ maxSuggestions: 1 });
    await pass();
    expect(runs()).toMatchObject([{ status: "failed" }]);
    expect(s.suggestions.get(made[0]!.id).status).toBe("open");
    expect(s.suggestions.get(made[1]!.id).status).toBe("rejected");
  });

  it("rejects a suggestion for a kind of target the setting doesn't allow", async () => {
    const made: Suggestion[] = [];
    const { s, withTask, turnOn, pass } = setup((services, request) => {
      made.push(suggestFor(services, "builtin:review", actorIn(request)));
    });
    withTask();
    turnOn({ targets: "prompts" });
    await pass();
    expect(s.suggestions.get(made[0]!.id)).toMatchObject({
      status: "rejected",
      outcome: expect.stringContaining("set to suggest changes to"),
    });
  });

  it("starts nothing for a project where nothing happened in the window", async () => {
    const { withTask, turnOn, pass, requests, setLater } = setup();
    withTask();
    turnOn({ lookBackDays: 3 });
    // Ten days on: the task is older than three days, and no run happened since.
    setLater(10 * DAY_MS);
    await pass();
    expect(requests).toHaveLength(0);
  });

  it("brings back the suggestion a dropped one had replaced", async () => {
    const made: Suggestion[] = [];
    const { s, withTask, turnOn, pass } = setup((services, request) => {
      for (const target of ["builtin:review", "builtin:plan"])
        made.push(suggestFor(services, target, actorIn(request)));
    });
    // Someone else's open suggestion for the second target, which the run's later one replaces.
    const earlier = suggestFor(s, "builtin:plan", "user-session");
    withTask();
    turnOn({ maxSuggestions: 1 });
    await pass();
    expect(s.suggestions.get(made[1]!.id).status).toBe("rejected");
    expect(s.suggestions.get(earlier.id)).toMatchObject({ status: "open", resolvedBy: null, outcome: null });
  });
});
