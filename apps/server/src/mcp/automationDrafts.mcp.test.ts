import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AUTOMATION_DRAFTS_MAX, type AutomationDraft } from "@repo/contracts";
import { createTestHarness } from "../test/harness.ts";

type Harness = ReturnType<typeof createTestHarness>;

const ORIGIN = { origin: "http://127.0.0.1:5317" };

async function connect(h: Harness) {
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4317/mcp"), {
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:4317");
      return Promise.resolve(h.app.request(url.pathname + url.search, { ...init, headers }));
    },
  });
  await client.connect(transport);
  return client;
}

const morningAgent = {
  name: "Morning triage",
  description: "Triages new defects every weekday morning",
  trigger: { kind: "schedule", schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:00" } },
  action: { kind: "agent", prompt: "Triage the defects in {{vars.jira_key}} from the last {{inputs.days}} days." },
  inputs: [{ name: "days", label: "Days to look back", type: "number", default: "1" }],
  slots: [{ name: "jira", label: "Jira tools", description: "search issues" }],
};

const nightlyScript = {
  name: "Nightly cleanup",
  trigger: { kind: "schedule", schedule: { kind: "hourly", everyHours: 24 } },
  action: { kind: "script", language: "node", body: "console.log('tidy')" },
};

describe("draft_automation", () => {
  let h: Harness;
  let agent: Client;

  const call = async (args: Record<string, unknown>) => {
    const result = (await agent.callTool({ name: "draft_automation", arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return { text, isError: result.isError === true };
  };
  const drafts = async () => (await (await h.request("/api/autopilot/drafts")).json()) as AutomationDraft[];

  beforeEach(async () => {
    h = createTestHarness({ integrations: { automations: [] } });
    agent = await connect(h);
  });
  afterEach(async () => {
    await agent.close();
    h.db.close();
  });

  it("keeps a draft for the user and links its import page, saving no automation", async () => {
    const alpha = h.services.projects.create({ title: "Alpha" });
    h.services.projects.create({ title: "Beta" });
    h.services.projects.update(alpha.id, { variables: [{ name: "jira_key", value: "ALP" }] });

    const { text, isError } = await call({
      automation: morningAgent,
      note: "Fill in your Jira tools.",
      actor: "claude-code",
    });

    expect(isError).toBe(false);
    const [draft] = await drafts();
    expect(draft).toMatchObject({ note: "Fill in your Jira tools.", createdBy: "claude-code" });
    expect(draft!.bundle).toMatchObject({ name: "Morning triage", version: 3 });
    expect(text).toContain(`/settings/autopilot/custom/import?draft=${draft!.id}`);
    expect(text).toContain("Jira tools");
    // Beta has no jira_key, so it would be skipped there.
    expect(text).toContain("- jira_key: no value in Beta");
    expect(h.services.customAutomations.list()).toEqual([]);
    expect(h.services.notifications.list().items[0]).toMatchObject({
      kind: "automation_draft",
      title: "Automation drafted: Morning triage",
    });
  });

  it("refuses a draft with every problem listed, so the agent can fix them all", async () => {
    const { text, isError } = await call({
      automation: {
        ...morningAgent,
        name: "",
        trigger: { kind: "stale", hours: 0 },
      },
    });

    expect(isError).toBe(true);
    expect(text).toContain("VALIDATION: The automation can't be drafted, 2 problems:");
    expect(text).toContain("- name:");
    expect(text).toContain("- trigger.hours:");
    expect(await drafts()).toEqual([]);
  });

  it("refuses what an import would refuse, such as a prompt naming an undeclared input", async () => {
    const { text, isError } = await call({
      automation: { ...morningAgent, inputs: [] },
    });

    expect(isError).toBe(true);
    expect(text).toContain("no input is called days");
  });

  it("tells a newer file's version apart from a malformed one", async () => {
    const { text, isError } = await call({ automation: { ...morningAgent, version: 99 } });

    expect(isError).toBe(true);
    expect(text).toContain("version 99, made by a newer");
  });

  it("still needs the user to confirm a script, from the board's page, and importing deletes the draft", async () => {
    const { text } = await call({ automation: nightlyScript });
    expect(text).toContain("confirm the script");
    const [draft] = await drafts();
    const body = { bundle: draft!.bundle, draftId: draft!.id };

    const unconfirmed = await h.request("/api/autopilot/custom/import", {
      method: "POST",
      json: body,
      headers: ORIGIN,
    });
    expect(unconfirmed.status).toBe(400);
    const noOrigin = await h.request("/api/autopilot/custom/import", {
      method: "POST",
      json: { ...body, confirmScript: true },
    });
    expect(noOrigin.status).toBe(400);
    expect(await drafts()).toHaveLength(1);

    const imported = await h.request("/api/autopilot/custom/import", {
      method: "POST",
      json: { ...body, confirmScript: true },
      headers: ORIGIN,
    });

    expect(imported.status).toBe(201);
    expect(h.services.customAutomations.list().map((c) => c.name)).toEqual(["Nightly cleanup"]);
    expect(await drafts()).toEqual([]);
    expect((await h.request(`/api/autopilot/drafts/${draft!.id}`)).status).toBe(404);
  });

  it("asks the user to read a drafted command, which has no script to confirm", async () => {
    const { text, isError } = await call({
      automation: { ...nightlyScript, action: { kind: "shell", command: "git gc" } },
    });

    expect(isError).toBe(false);
    expect(text).toContain("runs a command on the user's machine, so they must read it before importing it");
    expect(text).not.toContain("confirm the script");
  });

  it("drops a draft once it expires", async () => {
    await call({ automation: nightlyScript });
    const [draft] = await drafts();
    h.db.prepare("UPDATE autopilot_drafts SET expires_at = ?").run(new Date(Date.now() - 1_000).toISOString());

    expect(await drafts()).toEqual([]);
    expect((await h.request(`/api/autopilot/drafts/${draft!.id}`)).status).toBe(404);
    // The next draft prunes it from the table.
    await call({ automation: morningAgent });
    expect(h.db.prepare("SELECT count(*) AS n FROM autopilot_drafts").get()).toEqual({ n: 1 });
  });

  it("says when no project has a variable the draft reads", async () => {
    h.services.projects.create({ title: "Alpha" });

    const { text } = await call({ automation: morningAgent });

    expect(text).toContain("- jira_key: not set on the board or in any project");
  });

  it("keeps only the newest drafts", async () => {
    for (let n = 1; n <= AUTOMATION_DRAFTS_MAX + 2; n++) {
      await call({ automation: { ...nightlyScript, name: `Cleanup ${n}` } });
    }

    const kept = (await drafts()).map((d) => d.bundle.name);
    expect(kept).toHaveLength(AUTOMATION_DRAFTS_MAX);
    expect(kept).toContain(`Cleanup ${AUTOMATION_DRAFTS_MAX + 2}`);
    expect(kept).not.toContain("Cleanup 1");
  });

  it("lets the user dismiss a draft", async () => {
    await call({ automation: nightlyScript });
    const [draft] = await drafts();

    expect((await h.request(`/api/autopilot/drafts/${draft!.id}`, { method: "DELETE" })).status).toBe(204);

    expect(await drafts()).toEqual([]);
    expect(h.services.customAutomations.list()).toEqual([]);
  });
});
