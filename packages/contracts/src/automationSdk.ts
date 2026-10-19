import { brandEnv } from "./brand.ts";
import {
  CUSTOM_PLACEHOLDERS,
  customEnvName,
  inputEnvName,
  variableEnvName,
  type CustomScriptLanguage,
} from "./customAutomations.ts";

// What a custom automation's script or command can read, and how, per language (docs/features/autopilot.md#the-sdk-panel).
// The editor's panel shows it, and the authoring skill can quote the same text, so the two never disagree.

/** One value in scope: how a prompt, the environment and the stdin JSON each name it (null where it can't). */
export interface SdkValue {
  what: string;
  prompt: string | null;
  env: string | null;
  stdin: string | null;
}

/** Where the stdin JSON (customScriptContext) holds each placeholder's value. */
const STDIN_PATH: Record<string, string> = {
  "task.number": "task.number",
  "task.title": "task.title",
  "task.id": "task.id",
  "task.status": "task.status",
  "pr.url": "pr.url",
  "project.name": "project.name",
  "project.path": "project.path",
  "project.repo_url": "project.repoUrl",
  "automation.name": "automation",
};

/** Every value an action is given. `<name>` stands for an input's or a variable's own name. */
export const AUTOMATION_SDK_SCOPE: readonly SdkValue[] = [
  ...CUSTOM_PLACEHOLDERS.map((p) => ({
    what: p.label,
    prompt: `{{${p.key}}}`,
    env: customEnvName(p.env),
    stdin: STDIN_PATH[p.key] ?? null,
  })),
  { what: "An input", prompt: "{{inputs.<name>}}", env: inputEnvName("<name>"), stdin: "inputs.<name>" },
  { what: "A variable", prompt: "{{vars.<name>}}", env: variableEnvName("<name>"), stdin: "vars.<name>" },
  { what: "A check's item (its agent only)", prompt: "{{item.<field>}}", env: null, stdin: null },
];

/** A snippet of the panel: what it shows, for which scripts, and the code. */
export interface SdkSnippet {
  title: string;
  /** Which scripts it is for: an action, a check, or both. */
  roles: ReadonlyArray<"action" | "check">;
  code: string;
}

const VAR = variableEnvName("jira_key");
const INPUT = inputEnvName("days");
const NAME = brandEnv("PROJECT_NAME");

/** The snippets per language: reading the context, a variable, an input, printing a check's items and failing a run. */
export const AUTOMATION_SDK_SNIPPETS: Record<CustomScriptLanguage, readonly SdkSnippet[]> = {
  python: [
    {
      title: "Read the context",
      roles: ["action", "check"],
      code: [
        "import json, sys",
        "",
        "ctx = json.load(sys.stdin)",
        "print(f\"Hello world, this is running in {ctx['project']['name']}\")",
        "repo = ctx['project']['repoUrl']  # \"\" without an origin",
      ].join("\n"),
    },
    {
      title: "A variable and an input",
      roles: ["action", "check"],
      code: [
        "key = ctx['vars']['jira_key']  # needed: no run where it has no value",
        "team = ctx['vars'].get('team', '')  # optional: .get() isn't counted as needed",
        "days = int(ctx['inputs']['days'])",
        "# or from the environment:",
        `import os; key = os.environ["${VAR}"]`,
      ].join("\n"),
    },
    {
      title: "Print the items for agents",
      roles: ["check"],
      code: ["for issue in issues:", '    print(json.dumps({"key": issue["id"], "title": issue["title"]}))'].join("\n"),
    },
    {
      title: "Fail the run",
      roles: ["action", "check"],
      code: ['print("Nothing to deploy from", ctx["project"]["path"], file=sys.stderr)', "sys.exit(1)"].join("\n"),
    },
  ],
  node: [
    {
      title: "Read the context",
      roles: ["action", "check"],
      code: [
        'const ctx = JSON.parse(require("node:fs").readFileSync(0, "utf8"));',
        "console.log(`Hello world, this is running in ${ctx.project.name}`);",
        'const repo = ctx.project.repoUrl; // "" without an origin',
      ].join("\n"),
    },
    {
      title: "A variable and an input",
      roles: ["action", "check"],
      code: [
        "const key = ctx.vars.jira_key; // needed: no run where it has no value",
        'const days = Number(ctx.inputs.days ?? "7");',
        "// or from the environment:",
        `const fromEnv = process.env.${VAR};`,
      ].join("\n"),
    },
    {
      title: "Print the items for agents",
      roles: ["check"],
      code: "for (const issue of issues) console.log(JSON.stringify({ key: issue.id, title: issue.title }));",
    },
    {
      title: "Fail the run",
      roles: ["action", "check"],
      code: ['console.error("Nothing to deploy");', "process.exit(1);"].join("\n"),
    },
  ],
  powershell: [
    {
      title: "Read the context",
      roles: ["action", "check"],
      code: [
        "$ctx = [Console]::In.ReadToEnd() | ConvertFrom-Json",
        'Write-Output "Hello world, this is running in $($ctx.project.name)"',
        '$repo = $ctx.project.repoUrl  # "" without an origin',
      ].join("\n"),
    },
    {
      title: "A variable and an input",
      roles: ["action", "check"],
      code: [
        "$key = $ctx.vars.jira_key  # needed: no run where it has no value",
        "$days = [int]$ctx.inputs.days",
        "# or from the environment:",
        `$key = $env:${VAR}`,
      ].join("\n"),
    },
    {
      title: "Print the items for agents",
      roles: ["check"],
      code: "foreach ($issue in $issues) { @{ key = $issue.id; title = $issue.title } | ConvertTo-Json -Compress }",
    },
    {
      title: "Fail the run",
      roles: ["action", "check"],
      code: ['Write-Error "Nothing to deploy"', "exit 1"].join("\n"),
    },
  ],
  sh: [
    {
      title: "Read the values",
      roles: ["action", "check"],
      code: [
        "# sh can't parse JSON: read the environment (or pipe stdin to jq).",
        `echo "Hello world, this is running in $${NAME}"`,
        `repo="$${brandEnv("PROJECT_REPO_URL")}"  # empty without an origin`,
      ].join("\n"),
    },
    {
      title: "A variable and an input",
      roles: ["action", "check"],
      code: [`key="$${VAR}"  # needed: no run where it has no value`, `days="$\{${INPUT}:-7}"`].join("\n"),
    },
    {
      title: "Print the items for agents",
      roles: ["check"],
      code: `printf '{"key":"%s","title":"%s"}\\n' "$id" "$title"`,
    },
    {
      title: "Fail the run",
      roles: ["action", "check"],
      code: ['echo "Nothing to deploy" >&2', "exit 1"].join("\n"),
    },
  ],
};

/** What the panel says about exit codes and output, the same for every language. */
export const AUTOMATION_SDK_RULES: readonly string[] = [
  "It runs in the project's folder. Exit 0 and the run succeeds; any other exit, or running past the timeout, fails it, and a task it was about is flagged.",
  'What it prints is kept with the run (the last 4,000 characters). A check prints one JSON object per line, each with a "key"; anything else on stdout fails the check.',
  "Nothing is filled into the code itself: values arrive only through the environment and the JSON on stdin, so a task title can't change what runs.",
  'A variable it names (vars.x, vars["x"] or the environment variable) must have a value in a project for it to run there; vars.get("x") reads one as optional.',
];
