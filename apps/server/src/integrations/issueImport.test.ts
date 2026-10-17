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
    /** Sub-issue URLs by the parent issue's number; none by default. */
    fetchSubIssues?: (ref: { number: number }) => Promise<string[]>;
    runImport?: (job: ImportJob) => Promise<ImportOutcome>;
    /** The MCP servers the CLI reports as connected. */
    servers?: string[];
    listServers?: () => Promise<string[]>;
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
    github: {
      fetchIssue: opts.fetchIssue ?? (() => Promise.resolve(issue)),
      fetchSubIssues: opts.fetchSubIssues ?? (() => Promise.resolve([])),
    },
    runImport: (job) => {
      jobs.push(job);
      return opts.runImport ? opts.runImport(job) : Promise.resolve(outcome);
    },
    listMcpServers: (_cli, cwd) => {
      listed.push(cwd);
      return opts.listServers ? opts.listServers() : Promise.resolve(opts.servers ?? ["jira"]);
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
    // Not the project's folder: its .mcp.json and settings are the repo's, and the run doesn't load them.
    expect(jobs[0]!.cwd).toBe(tmpdir());
    expect(listed).toEqual([tmpdir()]);
    // Every server's write-looking tools are denied, whatever the user's settings allow.
    expect(jobs[0]!.denyTools).toEqual(expect.arrayContaining(["mcp__jira__create*", "mcp__slack__post*"]));
  });

  it("asks which servers are connected once for several imports", async () => {
    const { create, run, listed } = setup();
    await run(create("PROJ-7").id);
    await run(create("PROJ-8").id);
    expect(listed).toHaveLength(1);
  });

  it("shares one listing of MCP servers between imports that start together", async () => {
    let release: (servers: string[]) => void = () => {};
    const { s, create, importer, listed } = setup({
      listServers: () => new Promise<string[]>((resolve) => (release = resolve)),
    });
    importer.start(create("PROJ-7").id);
    importer.start(create("PROJ-8").id);
    await Promise.resolve();
    release(["jira"]);
    await importer.idle();
    expect(listed).toHaveLength(1);
    expect(s.imports.pending()).toEqual([]);
  });

  it("says why when the MCP servers couldn't be listed", async () => {
    const { create, run, warnings } = setup({ listServers: () => Promise.reject(new Error("claude not found")) });
    const failed = await run(create("PROJ-7").id);
    expect(failed.import?.error).toContain(
      "No Jira tool available (couldn't list Claude Code's MCP servers: claude not found)",
    );
    expect(warnings.join()).toContain("claude not found");
  });

  it("asks again after a listing that came back empty", async () => {
    const { create, run, listed } = setup({ servers: [] });
    await run(create("PROJ-7").id);
    await run(create("PROJ-8").id);
    expect(listed).toHaveLength(2);
  });

  it("uses the tools listed in Settings instead of looking for them", async () => {
    const { s, create, run, jobs } = setup({ servers: ["other"] });
    s.settings.update({ issueImportJiraTools: ["mcp__corp__read_ticket"] });
    await run(create("PROJ-7").id);
    expect(jobs[0]!.jiraTools).toEqual(["mcp__corp__read_ticket"]);
    // The server the rule names is covered by the deny rules too, though the CLI didn't list it.
    expect(jobs[0]!.denyTools).toEqual(expect.arrayContaining(["mcp__corp__create*", "mcp__other__create*"]));
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

describe("importing an epic", () => {
  const jiraEpic =
    (children: string[], total = children.length) =>
    (job: ImportJob) =>
      Promise.resolve(
        job.source.kind === "jira" && job.source.key === "PROJ-7"
          ? { ...outcome, title: "One-page checkout", epic: { children, total } }
          : { ...outcome, title: `Do ${job.source.kind === "jira" ? job.source.key : "it"}` },
      );
  const sorted = (values: Array<string | undefined>) => values.map(String).sort((a, b) => a.localeCompare(b));
  const notes = (task: { events: Array<{ type: string; payload: Record<string, unknown> }> }) =>
    task.events.filter((e) => e.type === "note").map((e) => String(e.payload.text));

  it("turns a Jira epic into an epic whose children each import on their own", async () => {
    const { s, create, run, jobs } = setup({ runImport: jiraEpic(["PROJ-8", "PROJ-9", "not a key", "PROJ-8"]) });
    const epic = await run(create("PROJ-7").id);
    expect(epic).toMatchObject({ kind: "epic", title: "One-page checkout", status: "backlog" });
    expect(epic.links[0]).toMatchObject({ kind: "jira", ref: { key: "PROJ-7" } });
    expect(epic.events.map((e) => e.type)).toContain("became_epic");
    expect(sorted(epic.children.map((c) => c.title))).toEqual(["Do PROJ-8", "Do PROJ-9"]);
    expect(epic.children.every((c) => c.import?.status === "done" && c.parent?.id === epic.id)).toBe(true);
    expect(jobs.map((j) => (j.source.kind === "jira" ? j.source.key : null))).toEqual(["PROJ-7", "PROJ-8", "PROJ-9"]);
    expect(notes(epic)).toEqual(["Skipped a child issue that wasn't a Jira key or issue URL."]);
    expect(s.tasks.summaries({ projectId: epic.projectId })).toHaveLength(3);
  });

  it("turns a GitHub issue with sub-issues into an epic", async () => {
    const subIssues: Record<number, string[]> = {
      45: ["https://github.com/acme/app/issues/46", "https://github.com/acme/lib/issues/2"],
    };
    const { create, run } = setup({ fetchSubIssues: (ref) => Promise.resolve(subIssues[ref.number] ?? []) });
    const epic = await run(create(GH_URL).id);
    expect(epic).toMatchObject({ kind: "epic", title: outcome.title });
    expect(sorted(epic.children.map((c) => c.links[0]?.url))).toEqual([
      "https://github.com/acme/app/issues/46",
      "https://github.com/acme/lib/issues/2",
    ]);
    expect(epic.children.every((c) => c.import?.status === "done")).toBe(true);
    expect(notes(epic)).toEqual([]);
  });

  it("leaves an issue without children a task, also when its sub-issues can't be read", async () => {
    const plain = setup();
    expect(await plain.run(plain.create(GH_URL).id)).toMatchObject({ kind: "task", children: [] });
    const broken = setup({ fetchSubIssues: () => Promise.reject(new Error("HTTP 404")) });
    expect(await broken.run(broken.create(GH_URL).id)).toMatchObject({ kind: "task", import: { status: "done" } });
    expect(broken.warnings.join()).toContain("HTTP 404");
  });

  it("puts children already on the board in the epic instead of creating them again", async () => {
    const { s, project, create, run } = setup({ runImport: jiraEpic(["PROJ-8", "PROJ-9", "PROJ-10", "PROJ-11"]) });
    const loose = s.tasks.create({ projectId: project.id, title: "Loose", links: [{ value: "PROJ-8" }] });
    const other = s.tasks.createEpic({ projectId: project.id, title: "Other epic" }, [], "user");
    const taken = s.tasks.create({
      projectId: project.id,
      title: "Taken",
      epicId: other.id,
      links: [{ value: "PROJ-9" }],
    });
    const archived = s.tasks.create({ projectId: project.id, title: "Old", links: [{ value: "PROJ-10" }] });
    s.tasks.update(archived.id, { archived: true }, "user");
    const elsewhere = s.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
    s.tasks.create({ projectId: elsewhere.id, title: "Beta's", links: [{ value: "PROJ-11" }] });

    const epic = await run(create("PROJ-7").id);
    const children = new Map(epic.children.map((c) => [c.id, c]));
    expect(children.has(loose.id)).toBe(true);
    expect(s.tasks.summary(loose.id).title).toBe("Loose");
    expect(children.has(taken.id)).toBe(false);
    expect(s.tasks.summary(taken.id).parent?.id).toBe(other.id);
    expect(children.has(archived.id)).toBe(false);
    // PROJ-10 (only archived) and PROJ-11 (only in another project) are new tasks.
    expect(epic.children).toHaveLength(3);
    expect(notes(epic)).toEqual([
      `Already on the board, so moved into this epic: #${loose.number}.\n\nLeft where they are, not added: PROJ-9 (#${taken.number} is in epic #${other.number}).`,
    ]);
  });

  it("imports at most 50 children and says how many there are", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `PROJ-${100 + i}`);
    const { run, create } = setup({ runImport: jiraEpic(keys, 120) });
    const epic = await run(create("PROJ-7").id);
    expect(epic.children).toHaveLength(50);
    expect(notes(epic)).toEqual([
      "PROJ-7 has 120 tasks; only the first 50 were imported. Add the rest by pasting their keys or URLs.",
    ]);
  });

  it("keeps the epic when a child's import fails", async () => {
    const base = jiraEpic(["PROJ-8", "PROJ-9"]);
    const { run, create } = setup({
      runImport: (job) =>
        job.source.kind === "jira" && job.source.key === "PROJ-9" ? Promise.reject(new Error("no access")) : base(job),
    });
    const epic = await run(create("PROJ-7").id);
    expect(epic.kind).toBe("epic");
    expect(sorted(epic.children.map((c) => c.import?.status))).toEqual(["done", "failed"]);
  });

  it("leaves a task that can't be an epic as it is, and says why", async () => {
    const { s, create, run, jobs } = setup({ runImport: jiraEpic(["PROJ-8"]) });
    const task = create("PROJ-7");
    s.tasks.update(task.id, { priority: true }, "user");
    const done = await run(task.id);
    expect(done).toMatchObject({ kind: "task", title: "One-page checkout", children: [], import: { status: "done" } });
    expect(notes(done)).toEqual([
      "PROJ-7 is an epic with 1 task, but this task can't become an epic: it is a priority. Its tasks weren't imported.",
    ]);
    expect(jobs).toHaveLength(1);
  });
});
