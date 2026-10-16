import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import type { IssueDetails } from "./github.ts";
import type { ImportJob, ImportOutcome } from "./headlessImport.ts";
import { createIssueImporter, MAX_IMPORT_ATTEMPTS } from "./issueImport.ts";

const GH_URL = "https://github.com/acme/app/issues/45";

const issue: IssueDetails = {
  title: "Export crashes on empty rows",
  body: "Steps:\n1. Export an empty table",
  labels: ["bug"],
  state: "open",
};
const outcome: ImportOutcome = {
  title: "Fix export crash on empty rows",
  description: "Exporting an empty table crashes.",
  labels: ["Bug", "export"],
  costUsd: 0.01,
};

function setup(
  opts: {
    fetchIssue?: () => Promise<IssueDetails>;
    runImport?: (job: ImportJob) => Promise<ImportOutcome>;
    /** The MCP servers the CLI reports as connected. */
    servers?: string[];
  } = {},
) {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const jobs: ImportJob[] = [];
  const listed: string[] = [];
  const warnings: string[] = [];
  const importer = createIssueImporter({
    services: () => s,
    github: { fetchIssue: opts.fetchIssue ?? (() => Promise.resolve(issue)) },
    runImport: (job) => {
      jobs.push(job);
      return opts.runImport ? opts.runImport(job) : Promise.resolve(outcome);
    },
    listMcpServers: (_cli, cwd) => {
      listed.push(cwd);
      return Promise.resolve(opts.servers ?? ["jira"]);
    },
    log: { warn: (message: string) => void warnings.push(message) },
  });
  const create = (sourceUrl: string) => s.tasks.create({ projectId: project.id, sourceUrl });
  const run = async (taskId: string) => {
    importer.start(taskId);
    await importer.idle();
    return s.tasks.detail(taskId);
  };
  return { h, s, project, importer, jobs, listed, warnings, create, run };
}

describe("issue import", () => {
  it("summarises a GitHub issue into the task and records its state on the link", async () => {
    const { s, create, run, jobs } = setup();
    s.tasks.create({ projectId: s.projects.list()[0]!.id, title: "Other", labels: ["ux"] });
    const done = await run(create(GH_URL).id);
    expect(done).toMatchObject({
      title: "Fix export crash on empty rows",
      description: "Exporting an empty table crashes.",
      labels: ["bug", "export"],
      import: { status: "done", error: null },
    });
    expect(done.links[0]).toMatchObject({ kind: "issue", snapshot: { state: "open", title: issue.title } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      model: "haiku",
      cwd: tmpdir(),
      boardLabels: ["ux"],
      source: { kind: "issue", repo: "acme/app", number: 45, title: issue.title },
    });
  });

  it("falls back to the issue as written when the model can't run", async () => {
    const { create, run, warnings } = setup({ runImport: () => Promise.reject(new Error("claude not found")) });
    const done = await run(create(GH_URL).id);
    expect(done).toMatchObject({
      title: issue.title,
      description: issue.body,
      labels: ["bug"],
      import: { status: "done" },
    });
    expect(warnings.join()).toContain("claude not found");
  });

  it("uses the issue as written, without running the model, when import is turned off", async () => {
    const { s, create, run, jobs } = setup();
    s.settings.update({ issueImportEnabled: false });
    const done = await run(create(GH_URL).id);
    expect(done).toMatchObject({ title: issue.title, import: { status: "done" } });
    expect(jobs).toEqual([]);
  });

  it("fails with the reason when the issue can't be read", async () => {
    const { s, create, run } = setup({ fetchIssue: () => Promise.reject(new Error("gh is not signed in")) });
    const failed = await run(create(GH_URL).id);
    expect(failed).toMatchObject({ title: "acme/app#45", import: { status: "failed", error: "gh is not signed in" } });
    expect(failed.events.map((e) => e.type)).toContain("import_failed");
    expect(s.imports.pending()).toEqual([]);
  });

  it("reads a Jira issue through the user's Jira tools", async () => {
    const { create, run, jobs, listed } = setup({
      servers: ["jira", "slack"],
      runImport: () => Promise.resolve({ ...outcome, labels: ["Jira"] }),
    });
    const done = await run(create("PROJ-7").id);
    expect(done).toMatchObject({ title: outcome.title, labels: ["jira"], import: { status: "done" } });
    expect(jobs[0]).toMatchObject({
      source: { kind: "jira", key: "PROJ-7" },
      jiraTools: expect.arrayContaining(["mcp__jira__get_jira_issue", "mcp__slack__get_jira_issue"]),
    });
    // The run and the look for servers are both in the project's folder, where its own servers load.
    expect(jobs[0]!.cwd).toBe("/work/alpha");
    expect(listed).toEqual(["/work/alpha"]);
    // Every server's write-looking tools are denied, whatever the user's settings allow.
    expect(jobs[0]!.denyTools).toEqual(expect.arrayContaining(["mcp__jira__*reate*", "mcp__slack__*ost*"]));
  });

  it("asks which servers are connected once for several imports", async () => {
    const { create, run, listed } = setup();
    await run(create("PROJ-7").id);
    await run(create("PROJ-8").id);
    expect(listed).toHaveLength(1);
  });

  it("uses the tools listed in Settings instead of looking for them", async () => {
    const { s, create, run, jobs } = setup({ servers: ["other"] });
    s.settings.update({ issueImportJiraTools: ["mcp__corp__read_ticket"] });
    await run(create("PROJ-7").id);
    expect(jobs[0]!.jiraTools).toEqual(["mcp__corp__read_ticket"]);
    // The server the rule names is covered by the deny rules too, though the CLI didn't list it.
    expect(jobs[0]!.denyTools).toEqual(expect.arrayContaining(["mcp__corp__*reate*", "mcp__other__*reate*"]));
  });

  it("fails a Jira import that has no Jira tool, or that is turned off, saying so", async () => {
    const none = setup({ servers: [] });
    const noTool = await none.run(none.create("PROJ-7").id);
    expect(noTool.import).toMatchObject({ status: "failed" });
    expect(noTool.import?.error).toContain("No Jira tool available");
    expect(none.jobs).toEqual([]);

    const off = setup();
    off.s.settings.update({ issueImportEnabled: false });
    const disabled = await off.run(off.create("PROJ-7").id);
    expect(disabled.import?.error).toContain("turned off");
  });

  it("fails a Jira import the model can't read, with its reason", async () => {
    const { create, run } = setup({ runImport: () => Promise.reject(new Error("PROJ-7 not found")) });
    expect((await run(create("PROJ-7").id)).import).toMatchObject({ status: "failed", error: "PROJ-7 not found" });
  });

  it("picks up pending imports after a restart, and gives up after a few tries", async () => {
    const { s, create, importer, jobs } = setup();
    const resumed = create(GH_URL);
    const stuck = create("https://github.com/acme/app/issues/46");
    for (let i = 0; i < MAX_IMPORT_ATTEMPTS; i++) s.imports.claim(stuck.id);
    importer.resume();
    await importer.idle();
    expect(s.tasks.summary(resumed.id).import?.status).toBe("done");
    expect(s.tasks.summary(stuck.id).import).toMatchObject({ status: "failed" });
    expect(s.tasks.summary(stuck.id).import?.error).toContain("Gave up");
    expect(jobs).toHaveLength(1);
  });

  it("runs a retried import again", async () => {
    let fail = true;
    const { s, create, run } = setup({
      fetchIssue: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(issue)),
    });
    const id = create(GH_URL).id;
    expect((await run(id)).import?.status).toBe("failed");
    fail = false;
    s.imports.retry(id, "user");
    expect(await run(id)).toMatchObject({ title: outcome.title, import: { status: "done" } });
  });

  it("lets an import finish for a task deleted or archived while it ran", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const slow = () =>
      new Promise<IssueDetails>((resolve) => {
        gate.release = () => resolve(issue);
      });
    const deleted = setup({ fetchIssue: slow });
    const gone = deleted.create(GH_URL);
    deleted.importer.start(gone.id);
    deleted.s.tasks.update(gone.id, { archived: true }, "user");
    deleted.s.tasks.delete(gone.id, "user");
    gate.release();
    await deleted.importer.idle();
    expect(deleted.s.imports.get(gone.id)).toBeNull();

    const archived = setup({ fetchIssue: slow });
    const task = archived.create(GH_URL);
    archived.importer.start(task.id);
    archived.s.tasks.update(task.id, { archived: true }, "user");
    gate.release();
    await archived.importer.idle();
    expect(archived.s.tasks.summary(task.id).import?.status).toBe("done");
  });

  it("does nothing for a task that has no pending import", async () => {
    const { s, project, importer, jobs } = setup();
    const plain = s.tasks.create({ projectId: project.id, title: "Plain" });
    importer.start(plain.id);
    await importer.idle();
    expect(jobs).toEqual([]);
  });
});
