import { customEnvName, type TestScriptResult } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { InterpreterMissingError, type ScriptRequest, type ScriptResult } from "../integrations/scriptRunner.ts";
import { createTestHarness } from "../test/harness.ts";

const ORIGIN = { origin: "http://127.0.0.1:5317" };
const URL = "/api/autopilot/custom/test-script";

const ran = (patch: Partial<ScriptResult> = {}): ScriptResult => ({
  exitCode: 0,
  output: "",
  timedOut: false,
  stdout: "",
  stdoutTruncated: false,
  stderr: "",
  ...patch,
});

function setup(script: (request: ScriptRequest) => Promise<ScriptResult> = async () => ran()) {
  const runs: ScriptRequest[] = [];
  const h = createTestHarness({
    integrations: {
      runScript: async (request) => {
        runs.push(request);
        return script(request);
      },
    },
  });
  const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const post = (json: unknown, headers: Record<string, string> = ORIGIN) =>
    h.request(URL, { method: "POST", json, headers });
  const body = (extra: Record<string, unknown> = {}) => ({
    projectId: project.id,
    role: "action",
    script: { language: "node", body: "console.log(1)", timeoutSeconds: 30 },
    ...extra,
  });
  return { h, runs, project, post, body };
}

describe("POST /api/autopilot/custom/test-script", () => {
  it("runs the script once in the project's folder and reports what it did", async () => {
    const s = setup(async () => ran({ exitCode: 3, stdout: "out\n", stderr: "err\n" }));
    const res = await s.post(s.body({ name: "Ping", inputs: { depth: "2" } }));
    expect(res.status).toBe(200);
    const result = (await res.json()) as TestScriptResult;
    expect(result).toMatchObject({ error: null, exitCode: 3, timedOut: false, stdout: "out\n", stderr: "err\n" });
    expect(result.items).toBeNull();
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({
      language: "node",
      cwd: "/work/alpha",
      timeoutMs: 30_000,
      context: { automation: "Ping", project: { name: "Alpha", path: "/work/alpha" }, inputs: { depth: "2" } },
    });
    expect(s.runs[0]!.env[customEnvName("PROJECT_NAME")]).toBe("Alpha");
  });

  it("gives the script the project's variables and its inputs as environment variables", async () => {
    const s = setup();
    s.h.services.settings.update({ automationVariables: [{ name: "team", value: "core" }] });
    s.h.services.projects.update(s.project.id, { variables: [{ name: "jira_key", value: "ALP" }] });
    await s.post(s.body({ inputs: { depth: "2" } }));
    expect(s.runs[0]!.context).toMatchObject({ vars: { team: "core", jira_key: "ALP" }, project: { repoUrl: "" } });
    expect(s.runs[0]!.env).toMatchObject({
      [customEnvName("VAR_JIRA_KEY")]: "ALP",
      [customEnvName("INPUT_DEPTH")]: "2",
    });
  });

  it("gives an action a task's values when asked, and a check none", async () => {
    const s = setup();
    const task = s.h.services.tasks.create({
      projectId: s.project.id,
      title: "Do it",
      plan: { phases: [{ title: "P", steps: [{ title: "S" }] }] },
    });
    await s.post(s.body({ taskId: task.id }));
    await s.post(s.body({ taskId: task.id, role: "check" }));
    expect(s.runs[0]!.context).toMatchObject({ task: { id: task.id, title: "Do it" } });
    expect(s.runs[1]!.context).toMatchObject({ task: null });
  });

  it("reads a check's output as items and fills the prompt the first one would start", async () => {
    const stdout = [
      JSON.stringify({ key: "pr-1", title: "Fix <it>" }),
      "",
      JSON.stringify({ key: "pr-2", title: "Other" }),
    ].join("\n");
    const s = setup(async () => ran({ stdout }));
    const res = await s.post(
      s.body({ role: "check", name: "Triage", prompt: "Look at {{item.title}} ({{item.key}})" }),
    );
    const result = (await res.json()) as TestScriptResult;
    expect(result.items).toMatchObject({ items: [{ key: "pr-1" }, { key: "pr-2" }], dropped: 0 });
    const { prompt } = result.items as { prompt: string | null };
    expect(prompt).toContain("Look at Fix <it> (pr-1)");
    expect(prompt).toContain("<item>");
    expect(prompt).not.toContain("Other");
  });

  it("says why a check's output isn't items, and shows no prompt", async () => {
    const s = setup(async () => ran({ stdout: "hello\n" }));
    const result = (await (await s.post(s.body({ role: "check", prompt: "x" }))).json()) as TestScriptResult;
    expect(result.items).toEqual({ problem: expect.stringContaining("Line 1 isn't JSON") });
  });

  it("reads no items from a check that failed or timed out", async () => {
    const failing = setup(async () => ran({ exitCode: 1, stdout: '{"key":"a"}' }));
    const failed = (await (await failing.post(failing.body({ role: "check" }))).json()) as TestScriptResult;
    expect(failed).toMatchObject({ exitCode: 1, items: null });
    const s = setup(async () => ran({ exitCode: null, timedOut: true }));
    const timedOut = (await (await s.post(s.body({ role: "check" }))).json()) as TestScriptResult;
    expect(timedOut).toMatchObject({ exitCode: null, timedOut: true, items: null });
  });

  it("answers, rather than fails, when the interpreter is missing", async () => {
    const s = setup(async () => {
      throw new InterpreterMissingError("pwsh");
    });
    const res = await s.post(s.body({ script: { language: "powershell", body: "1", timeoutSeconds: 5 } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      error: "The script couldn't run: pwsh not found on PATH",
      exitCode: null,
    });
  });

  it("cuts long output for display and says so", async () => {
    const s = setup(async () => ran({ stdout: "x".repeat(60_000) }));
    const result = (await (await s.post(s.body())).json()) as TestScriptResult;
    expect(result.stdout).toHaveLength(50_000);
    expect(result.truncated).toBe(true);
  });

  it("runs from the board's page only, and runs nothing otherwise", async () => {
    const s = setup();
    const res = await s.post(s.body(), {});
    expect(res.status).toBe(400);
    expect(s.runs).toHaveLength(0);
  });

  it("refuses an empty script, an unknown project and a project with no folder, running nothing", async () => {
    const s = setup();
    expect((await s.post(s.body({ script: { language: "sh", body: "  ", timeoutSeconds: 5 } }))).status).toBe(400);
    expect((await s.post(s.body({ projectId: "nope" }))).status).toBe(404);
    const bare = s.h.services.projects.create({ title: "Bare" });
    expect((await s.post(s.body({ projectId: bare.id }))).status).toBe(400);
    expect(s.runs).toHaveLength(0);
  });

  it("runs one test at a time", async () => {
    let release = () => {};
    const s = setup(() => new Promise<ScriptResult>((resolve) => (release = () => resolve(ran()))));
    const first = s.post(s.body());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await s.post(s.body())).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(s.runs).toHaveLength(1);
    // Free again afterwards.
    release = () => {};
    const again = s.post(s.body());
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect((await again).status).toBe(200);
  });

  it("gives an action and a check their inputs, as a real run would", async () => {
    const s = setup();
    await s.post(s.body({ inputs: { depth: "2" } }));
    await s.post(s.body({ role: "check", inputs: { depth: "2" } }));
    expect(s.runs[0]!.context).toMatchObject({ inputs: { depth: "2" } });
    expect(s.runs[1]!.context).toMatchObject({ inputs: { depth: "2" } });
  });

  it("lists a check's items without a prompt when none was written, and says when it printed none", async () => {
    const printed = setup(async () => ran({ stdout: JSON.stringify({ key: "a" }) }));
    const withItems = (await (await printed.post(printed.body({ role: "check" }))).json()) as TestScriptResult;
    expect(withItems.items).toEqual({ items: [{ key: "a" }], dropped: 0, prompt: null });
    const quiet = setup();
    const none = (await (await quiet.post(quiet.body({ role: "check", prompt: "x" }))).json()) as TestScriptResult;
    expect(none.items).toEqual({ items: [], dropped: 0, prompt: null });
  });

  it("refuses to read the items of a check that printed more than the board keeps", async () => {
    const s = setup(async () => ran({ stdout: JSON.stringify({ key: "a" }), stdoutTruncated: true }));
    const result = (await (await s.post(s.body({ role: "check", prompt: "x" }))).json()) as TestScriptResult;
    expect(result.items).toEqual({ problem: "It printed more than the board reads" });
    expect(result.truncated).toBe(true);
  });

  it("keeps the end of a long stderr, and shows no items for an action", async () => {
    const stderr = `start${"e".repeat(60_000)}end`;
    const s = setup(async () => ran({ stderr }));
    const result = (await (await s.post(s.body())).json()) as TestScriptResult;
    expect(result.stderr).toHaveLength(50_000);
    expect(result.stderr.endsWith("end")).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.items).toBeNull();
  });

  it("is a 404 for an unknown task, running nothing", async () => {
    const s = setup();
    expect((await s.post(s.body({ taskId: "nope" }))).status).toBe(404);
    expect(s.runs).toHaveLength(0);
  });

  it("answers with the error when the runner throws, and is free for the next test", async () => {
    let calls = 0;
    const s = setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error("spawn exploded");
      return ran();
    });
    const failed = (await (await s.post(s.body())).json()) as TestScriptResult;
    expect(failed).toMatchObject({ error: "spawn exploded", exitCode: null });
    expect((await s.post(s.body())).status).toBe(200);
  });
});
