import { brandEnv, CustomAction, variablesNamedBy } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { applyInsert, insertChips, knownVariables, readValue } from "./insertChips.logic";

const labels = (chips: ReturnType<typeof insertChips>) => chips.map((c) => c.label);

describe("insertChips", () => {
  it("inserts placeholders into a prompt, with the item only for a check's agent", () => {
    const chips = insertChips({ target: "prompt", inputs: ["days"], variables: ["jira_key"] });
    expect(labels(chips)).toEqual(["project", "task", "pr.url", "automation", "vars", "inputs"]);
    expect(chips.find((c) => c.label === "project")?.options.map((o) => o.text)).toContain("{{project.repo_url}}");
    expect(chips.find((c) => c.label === "vars")?.options[0]?.text).toBe("{{vars.jira_key}}");
    expect(chips.find((c) => c.label === "inputs")?.options[0]?.text).toBe("{{inputs.days}}");
    const checking = insertChips({ target: "prompt", inputs: [], variables: [], hasTask: false, checking: true });
    expect(labels(checking)).toEqual(["project", "automation", "vars", "item"]);
  });

  it("reads code values from ctx, naming the environment variable as the other way", () => {
    const chips = insertChips({ target: "python", inputs: [], variables: ["jira_key"] });
    const repo = chips.find((c) => c.label === "project")?.options.find((o) => o.label === "Repository URL");
    expect(repo).toEqual({
      label: "Repository URL",
      text: "ctx['project']['repoUrl']",
      also: `env: ${brandEnv("PROJECT_REPO_URL")}`,
    });
    expect(chips.find((c) => c.label === "vars")?.options[0]?.text).toBe("ctx['vars']['jira_key']");
  });

  it("leaves out the task and PR for a schedule, and explains an empty vars chip", () => {
    const chips = insertChips({ target: "sh", inputs: [], variables: [], hasTask: false });
    expect(labels(chips)).toEqual(["project", "automation", "vars"]);
    const vars = chips.find((c) => c.label === "vars");
    expect(vars?.options).toEqual([]);
    expect(vars?.empty).toBeTruthy();
  });
});

describe("readValue", () => {
  it("reads ctx in each language, and the environment in sh", () => {
    const name = brandEnv("PROJECT_NAME");
    expect(readValue("node", "project.name", name)).toBe("ctx.project.name");
    expect(readValue("python", "project.name", name)).toBe("ctx['project']['name']");
    expect(readValue("powershell", "project.name", name)).toBe("$ctx.project.name");
    expect(readValue("sh", "project.name", name)).toBe(`"$${name}"`);
    expect(readValue("node", "automation", brandEnv("AUTOMATION"))).toBe("ctx.automation");
  });

  it("doesn't fail on a task without a pull request", () => {
    expect(readValue("node", "pr.url", brandEnv("PR_URL"))).toBe("ctx.pr?.url");
    expect(readValue("python", "pr.url", brandEnv("PR_URL"))).toBe("(ctx['pr'] or {}).get('url', '')");
  });

  it("reads a variable so that the automation counts it as needed", () => {
    for (const language of ["node", "python", "powershell", "sh"] as const) {
      const body = readValue(language, "vars.jira_key", brandEnv("VAR_JIRA_KEY"));
      const action = CustomAction.parse({ kind: "script", language, body });
      expect(variablesNamedBy(action)).toEqual(["jira_key"]);
    }
  });
});

describe("knownVariables", () => {
  it("merges the board's and every project's names, once each, sorted", () => {
    expect(
      knownVariables(
        [{ name: "team" }, { name: "jira_key" }],
        [{ variables: [{ name: "jira_key" }, { name: "env" }] }],
      ),
    ).toEqual(["env", "jira_key", "team"]);
  });
});

describe("applyInsert", () => {
  it("replaces the selection and puts the cursor after the text", () => {
    expect(applyInsert("print()", 6, 6, "ctx.automation")).toEqual({ value: "print(ctx.automation)", cursor: 20 });
    expect(applyInsert("a XX b", 2, 4, "y")).toEqual({ value: "a y b", cursor: 3 });
  });
});
