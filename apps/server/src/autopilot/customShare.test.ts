import {
  AUTOMATION_BUNDLE_VERSION,
  SCRIPT_BUNDLE_VERSION,
  PLAIN_BUNDLE_VERSION,
  BRAND,
  AUTOMATION_EXAMPLES,
  customAutomationKey,
  CustomAction,
  automationBundle as automationBundleOf,
  type AutomationBundle,
  CreateCustomAutomationInput,
  type CustomAutomation,
} from "@repo/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { createAutopilotEngine, type AutopilotEngine } from "./engine.ts";
import type { RunnerRequest } from "./types.ts";

const SKILL = "---\nname: triage\ndescription: Triage defects\n---\nLook at each defect.";
const ORIGIN = { origin: "http://127.0.0.1:5317" };

const engines: AutopilotEngine[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Action = CreateCustomAutomationInput["action"];

function setup(aheadMs = 2 * 3_600_000) {
  // The user's home is a throwaway folder: an import writes skills into it.
  const home = mkdtempSync(join(tmpdir(), "share-test-home-"));
  homes.push(home);
  const h = createTestHarness({ userHome: home, integrations: { automations: [] } });
  const agentRuns: RunnerRequest[] = [];
  const engine = createAutopilotEngine({
    services: () => h.services,
    bus: h.bus,
    runner: {
      start: (request) => {
        agentRuns.push(request);
        return Promise.resolve({ runner: "headless", result: null, output: { summary: "ok", handover: "" } });
      },
    },
    // Two hours on by default, so the hourly slot after the automation was made has come.
    now: () => new Date(Date.now() + aheadMs),
    debounceMs: 5,
    tickMs: 1_000_000,
    log: { warn: () => {} },
  });
  engines.push(engine);
  const skillDir = (name: string) => join(home, ".claude", "skills", name);
  const installSkill = (name: string, body = SKILL) => {
    mkdirSync(skillDir(name), { recursive: true });
    writeFileSync(join(skillDir(name), "SKILL.md"), body);
  };
  const json = async <T>(res: Response) => (await res.json()) as T;
  return { ...h, home, engine, agentRuns, skillDir, installSkill, json };
}

type Setup = ReturnType<typeof setup>;

const jira = { name: "jira", label: "Jira tools", description: "search issues by JQL" };
const triageAction = (extra: Record<string, unknown> = {}): Action =>
  CustomAction.parse({
    kind: "agent",
    prompt: "Run {{inputs.jql}} and triage the defects.",
    skill: "triage",
    inputs: [{ name: "jql", label: "JQL", value: "type = Bug" }],
    slots: [jira],
    ...extra,
  });
const triage = (action: Action = triageAction()): CreateCustomAutomationInput => ({
  name: "Triage",
  trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } },
  filters: { projectIds: [] },
  action,
});

const exportOf = async (s: Setup, custom: CustomAutomation) =>
  s.json<AutomationBundle>(await s.request(`/api/autopilot/custom/${custom.id}/export`));

describe("exporting a custom automation", () => {
  it("leaves out projects and slot tools, and carries the skill the action names", async () => {
    const s = setup();
    s.installSkill("triage");
    const project = s.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const custom = s.services.customAutomations.create({
      ...triage(triageAction({ slots: [{ ...jira, tools: ["mcp__issue-tracker__search_jira"] }] })),
      filters: { projectIds: [project.id] },
    });
    const bundle = await exportOf(s, custom);
    expect(bundle).toMatchObject({
      version: PLAIN_BUNDLE_VERSION,
      name: "Triage",
      inputs: [{ name: "jql", default: "type = Bug" }],
      slots: [jira],
      skill: { name: "triage", body: SKILL },
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(project.id);
    expect(text).not.toContain("search_jira");
  });

  it("carries no skill when the named one isn't installed", async () => {
    const s = setup();
    const custom = s.services.customAutomations.create(triage());
    expect((await exportOf(s, custom)).skill).toBeUndefined();
  });

  it("is a 404 for an automation that doesn't exist", async () => {
    const s = setup();
    expect((await s.request("/api/autopilot/custom/nope/export")).status).toBe(404);
  });
});

describe("importing a custom automation", () => {
  const post = (s: Setup, body: unknown, headers?: Record<string, string>) =>
    s.request("/api/autopilot/custom/import", { method: "POST", json: body, ...(headers ? { headers } : {}) });
  type Imported = { automation: CustomAutomation; skill: { name: string; renamed: boolean } | null };

  /** A file as another user's board would have exported it. */
  const fileOf = async () => {
    const other = setup();
    other.installSkill("triage");
    return exportOf(other, other.services.customAutomations.create(triage()));
  };

  it("round-trips into an automation that is off, with the importer's inputs, tools and projects", async () => {
    const bundle = await fileOf();
    const s = setup();
    const project = s.services.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
    const res = await post(
      s,
      {
        bundle,
        inputs: { jql: "project = BETA" },
        slots: { jira: ["mcp__atlassian__search"] },
        projectIds: [project.id],
        installSkill: true,
      },
      ORIGIN,
    );
    expect(res.status).toBe(201);
    const { automation, skill } = await s.json<Imported>(res);
    expect(skill).toMatchObject({ name: "triage", renamed: false });
    expect(readFileSync(join(s.skillDir("triage"), "SKILL.md"), "utf8")).toBe(SKILL);
    expect(automation).toMatchObject({
      name: "Triage",
      filters: { projectIds: [project.id], epicId: null },
      action: {
        kind: "agent",
        skill: "triage",
        inputs: [{ name: "jql", value: "project = BETA", default: "type = Bug" }],
        slots: [{ name: "jira", tools: ["mcp__atlassian__search"] }],
      },
    });
    // Off until the user switches it on.
    const entry = s.services.autopilot
      .scope("board", null)
      .find((e) => e.automation === customAutomationKey(automation.id));
    expect(entry).toMatchObject({ mode: "inherit", enabled: false });
  });

  it("renames the skill when its name is taken, and never overwrites the user's own", async () => {
    const bundle = await fileOf();
    const s = setup();
    s.installSkill("triage", "---\nname: triage\n---\nMine");
    const { automation, skill } = await s.json<Imported>(await post(s, { bundle, installSkill: true }, ORIGIN));
    expect(skill).toMatchObject({ name: "triage-2", renamed: true });
    expect(automation.action).toMatchObject({ skill: "triage-2" });
    expect(readFileSync(join(s.skillDir("triage"), "SKILL.md"), "utf8")).toContain("Mine");
    expect(readFileSync(join(s.skillDir("triage-2"), "SKILL.md"), "utf8")).toContain("name: triage-2");
  });

  it("writes no skill unless asked, and then names none", async () => {
    const bundle = await fileOf();
    const s = setup();
    const { automation, skill } = await s.json<Imported>(await post(s, { bundle }));
    expect(skill).toBeNull();
    expect(existsSync(s.skillDir("triage"))).toBe(false);
    expect(automation.action).toMatchObject({ skill: "" });
  });

  it("gives a name that is taken a number", async () => {
    const bundle = await fileOf();
    const s = setup();
    s.services.customAutomations.create(triage());
    const first = await s.json<Imported>(await post(s, { bundle }));
    const second = await s.json<Imported>(await post(s, { bundle }));
    expect([first.automation.name, second.automation.name]).toEqual(["Triage (2)", "Triage (3)"]);
  });

  it("refuses what isn't an automation file, a newer version and a definition that can't run, writing nothing", async () => {
    const bundle = await fileOf();
    const s = setup();
    const refused = async (body: unknown, message: RegExp, headers?: Record<string, string>) => {
      const res = await post(s, body, headers);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(message);
    };
    await refused({ bundle: { hello: "world" } }, /automation file/);
    await refused({ bundle: { ...bundle, version: AUTOMATION_BUNDLE_VERSION + 1 } }, /newer/);
    await refused({ bundle, slots: { jira: ["Bash"] }, installSkill: true }, /Bash|Use mcp__/, ORIGIN);
    await refused(
      {
        bundle: {
          ...bundle,
          inputs: [{ name: "jql", label: "JQL", type: "number", default: "soon" }],
        },
        installSkill: true,
      },
      /enter a number/,
      ORIGIN,
    );
    expect(existsSync(s.skillDir("triage"))).toBe(false);
    expect(s.services.customAutomations.list()).toHaveLength(0);
  });

  it("installs a skill only from the board's page, writing nothing otherwise", async () => {
    const bundle = await fileOf();
    const s = setup();
    const refused = await post(s, { bundle, installSkill: true });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(/Skills can only be installed/);
    expect(existsSync(s.skillDir("triage"))).toBe(false);
    expect(s.services.customAutomations.list()).toHaveLength(0);
    // Without asking for the skill, no Origin is needed.
    expect((await post(s, { bundle })).status).toBe(201);
  });

  it("writes the skill under the name it installs as, whatever the file's own name line says", async () => {
    const bundle = await fileOf();
    const s = setup();
    s.installSkill("commit", "---\nname: commit\n---\nMine");
    const body = "---\nname: commit\ndescription: x\n---\nBody\nname: not-this";
    const withBody = { ...bundle, skill: { name: "triage", body } };
    const { skill } = await s.json<Imported>(await post(s, { bundle: withBody, installSkill: true }, ORIGIN));
    expect(skill).toMatchObject({ name: "triage", renamed: false });
    expect(readFileSync(join(s.skillDir("triage"), "SKILL.md"), "utf8")).toBe(
      "---\nname: triage\ndescription: x\n---\nBody\nname: not-this",
    );
    // No frontmatter at all: one is added.
    const bare = { ...bundle, name: "Plain", skill: { name: "plain", body: "Just text" } };
    await post(s, { bundle: bare, installSkill: true }, ORIGIN);
    expect(readFileSync(join(s.skillDir("plain"), "SKILL.md"), "utf8")).toBe("---\nname: plain\n---\nJust text");
    // A frontmatter block without a name gets one.
    const noName = { ...bundle, name: "NoName", skill: { name: "nn", body: "---\ndescription: d\n---\nT" } };
    await post(s, { bundle: noName, installSkill: true }, ORIGIN);
    expect(readFileSync(join(s.skillDir("nn"), "SKILL.md"), "utf8")).toBe("---\nname: nn\ndescription: d\n---\nT");
    // An empty frontmatter block is filled in, not followed by a second one.
    const empty = { ...bundle, name: "Empty", skill: { name: "em", body: "---\n---\nBody\n---\nmore" } };
    await post(s, { bundle: empty, installSkill: true }, ORIGIN);
    expect(readFileSync(join(s.skillDir("em"), "SKILL.md"), "utf8")).toBe("---\nname: em\n---\nBody\n---\nmore");
  });

  it("takes a shell command only from the board's page", async () => {
    const bundle = { ...(await fileOf()), inputs: [], slots: [], action: { kind: "shell", command: "make" } };
    const s = setup();
    expect((await post(s, { bundle })).status).toBe(400);
    expect((await post(s, { bundle }, ORIGIN)).status).toBe(201);
  });
});

describe("sharing a script", () => {
  const script = { kind: "script", language: "python", body: "print('hi')\n  # as written\n" } as const;
  const scriptAutomation = (): CreateCustomAutomationInput => ({
    name: "Check",
    trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 1 } },
    filters: { projectIds: [] },
    action: CustomAction.parse(script),
  });
  const post = (s: Setup, body: unknown, headers?: Record<string, string>) =>
    s.request("/api/autopilot/custom/import", { method: "POST", json: body, ...(headers ? { headers } : {}) });

  it("exports it as a version 2 file, and an agent's file stays at version 1", async () => {
    const s = setup();
    const bundle = await exportOf(s, s.services.customAutomations.create(scriptAutomation()));
    expect(bundle).toMatchObject({ version: SCRIPT_BUNDLE_VERSION, action: script });
    expect((await exportOf(s, s.services.customAutomations.create(triage()))).version).toBe(PLAIN_BUNDLE_VERSION);
  });

  it("imports only once the importer confirms, from the board's page, writing nothing otherwise", async () => {
    const bundle = automationBundleOf(CreateCustomAutomationInput.parse(scriptAutomation()));
    const s = setup();
    const unconfirmed = await post(s, { bundle }, ORIGIN);
    expect(unconfirmed.status).toBe(400);
    expect(JSON.stringify(await unconfirmed.json())).toMatch(/runs a script on your machine/);
    const noOrigin = await post(s, { bundle, confirmScript: true });
    expect(noOrigin.status).toBe(400);
    expect(JSON.stringify(await noOrigin.json())).toMatch(/Scripts can only be set/);
    expect(s.services.customAutomations.list()).toHaveLength(0);

    const res = await post(s, { bundle, confirmScript: true }, ORIGIN);
    expect(res.status).toBe(201);
    const { automation } = await s.json<{ automation: CustomAutomation }>(res);
    expect(automation.action).toMatchObject({ ...script, timeoutSeconds: 300 });
    // Off until the user switches it on.
    const entry = s.services.autopilot
      .scope("board", null)
      .find((e) => e.automation === customAutomationKey(automation.id));
    expect(entry).toMatchObject({ mode: "inherit", enabled: false });
  });

  it("refuses a confirmation the service wasn't given, whoever calls it", () => {
    const s = setup();
    const bundle = automationBundleOf(CreateCustomAutomationInput.parse(scriptAutomation()));
    expect(() => s.services.customAutomations.importBundle({ bundle })).toThrow(/runs a script on your machine/);
    expect(s.services.customAutomations.importBundle({ bundle, confirmScript: true }).automation.action).toMatchObject(
      script,
    );
  });

  it("needs no confirmation for a file without a script", async () => {
    const s = setup();
    const bundle = await exportOf(s, s.services.customAutomations.create(triage()));
    expect((await post(s, { bundle })).status).toBe(201);
  });
});

describe("a required tool slot", () => {
  const key = (custom: CustomAutomation) => encodeURIComponent(customAutomationKey(custom.id));
  const filled = triageAction({
    allowedTools: ["WebFetch"],
    slots: [{ ...jira, tools: ["mcp__issue-tracker__search_jira"] }],
  });

  it("can't be switched on while empty, and says what is missing", async () => {
    const s = setup();
    const custom = s.services.customAutomations.create(triage());
    const refused = await s.request(`/api/autopilot/board/${key(custom)}`, { method: "PUT", json: { mode: "on" } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain("Won't work until you fill in: Jira tools");
    const catalogue = await s.json<{ automations: Array<{ key: string; blocked: string | null }> }>(
      await s.request("/api/autopilot"),
    );
    expect(catalogue.automations.find((a) => a.key === customAutomationKey(custom.id))?.blocked).toMatch(/Jira tools/);

    await s.request(`/api/autopilot/custom/${custom.id}`, { method: "PATCH", json: { action: filled } });
    const on = await s.request(`/api/autopilot/board/${key(custom)}`, { method: "PUT", json: { mode: "on" } });
    expect(on.status).toBe(200);
  });

  it("gives the run its tools and tells the prompt which they are, and starts nothing once emptied", async () => {
    const s = setup();
    const project = s.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const custom = s.services.customAutomations.create(triage(filled));
    s.services.autopilot.setScope("board", null, customAutomationKey(custom.id), { mode: "on" });
    await s.engine.pass();
    await s.engine.idle();
    expect(s.agentRuns).toHaveLength(1);
    const request = s.agentRuns[0]!;
    expect(request.tools).toEqual(["WebFetch", "mcp__issue-tracker__search_jira"]);
    expect(request.prompt).toContain("Run type = Bug and triage the defects.");
    expect(request.prompt).toContain("- Jira tools (search issues by JQL): mcp__issue-tracker__search_jira");
    expect(s.services.autopilot.runsForProject(project.id)).toHaveLength(1);

    // Emptying the slot of an automation that is already on stops it rather than starting an agent without its tools.
    s.services.customAutomations.update(custom.id, { action: triageAction() });
    s.services.customAutomations.rearm(custom.id, [project.id]);
    await s.engine.pass();
    await s.engine.idle();
    expect(s.agentRuns).toHaveLength(1);
  });
});

describe("the Improve example", () => {
  it("imports with its skill, and its weekly run uses the skill on the deep tier with the filled inputs", async () => {
    // Eight days on, so a weekly slot has come whatever today is.
    const s = setup(8 * 24 * 3_600_000);
    const project = s.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    const bundle = AUTOMATION_EXAMPLES.find((e) => e.id === "improve")!.bundle;
    const res = await s.request("/api/autopilot/custom/import", {
      method: "POST",
      json: { bundle, inputs: { max_suggestions: "1" }, projectIds: [project.id], installSkill: true },
      headers: ORIGIN,
    });
    expect(res.status).toBe(201);
    const { automation } = await s.json<{ automation: CustomAutomation }>(res);
    const skill = `${BRAND.id}-improve`;
    expect(automation.action).toMatchObject({ skill, tier: "deep" });
    expect(readFileSync(join(s.skillDir(skill), "SKILL.md"), "utf8")).toContain(`name: ${skill}`);

    s.services.autopilot.setScope("board", null, customAutomationKey(automation.id), { mode: "on" });
    await s.engine.pass();
    await s.engine.idle();
    expect(s.agentRuns).toHaveLength(1);
    const request = s.agentRuns[0]!;
    expect(request.tier).toBe("deep");
    expect(request.tools).toEqual(["Skill"]);
    expect(request.prompt).toContain(`Use the ${skill} skill.`);
    expect(request.prompt).toContain('since "7d"');
    expect(request.prompt).toContain("at most 1 changes");
    expect(request.prompt).toContain("You may suggest changes to: all.");
    expect(request.prompt).toContain("Project folder: /work/alpha");
  });
});
