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
    jiraTools?: string[];
  } = {},
) {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const jobs: ImportJob[] = [];
  const warnings: string[] = [];
  const importer = createIssueImporter({
    services: () => s,
    github: { fetchIssue: opts.fetchIssue ?? (() => Promise.resolve(issue)) },
    runImport: (job) => {
      jobs.push(job);
      return opts.runImport ? opts.runImport(job) : Promise.resolve(outcome);
    },
    discoverJiraTools: () => Promise.resolve(opts.jiraTools ?? ["mcp__jira__get_jira_issue"]),
    log: { warn: (message: string) => void warnings.push(message) },
  });
  const create = (sourceUrl: string) => s.tasks.create({ projectId: project.id, sourceUrl });
  const run = async (taskId: string) => {
    importer.start(taskId);
    await importer.idle();
    return s.tasks.detail(taskId);
  };
  return { h, s, project, importer, jobs, warnings, create, run };
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
    const { create, run, jobs } = setup({ runImport: () => Promise.resolve({ ...outcome, labels: ["Jira"] }) });
    const done = await run(create("PROJ-7").id);
    expect(done).toMatchObject({ title: outcome.title, labels: ["jira"], import: { status: "done" } });
    expect(jobs[0]).toMatchObject({
      source: { kind: "jira", key: "PROJ-7" },
      jiraTools: ["mcp__jira__get_jira_issue"],
    });
    expect(jobs[0]!.cwd).toBe("/work/alpha");
  });

  it("uses the tools listed in Settings instead of looking for them", async () => {
    const { s, create, run, jobs } = setup({ jiraTools: ["mcp__other__get_jira_issue"] });
    s.settings.update({ issueImportJiraTools: ["mcp__corp__read_ticket"] });
    await run(create("PROJ-7").id);
    expect(jobs[0]!.jiraTools).toEqual(["mcp__corp__read_ticket"]);
  });

  it("fails a Jira import that has no Jira tool, or that is turned off, saying so", async () => {
    const none = setup({ jiraTools: [] });
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

  it("does nothing for a task that has no pending import", async () => {
    const { s, project, importer, jobs } = setup();
    const plain = s.tasks.create({ projectId: project.id, title: "Plain" });
    importer.start(plain.id);
    await importer.idle();
    expect(jobs).toEqual([]);
  });
});
