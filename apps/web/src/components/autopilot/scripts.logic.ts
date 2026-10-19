import { customEnvName, type CustomScriptLanguage, type TestScriptResult } from "@repo/contracts";

/** The languages a script can be written in, with what each needs on this machine (the board checks when it runs). */
export const SCRIPT_LANGUAGES: ReadonlyArray<{ value: CustomScriptLanguage; label: string; needs: string }> = [
  {
    value: "node",
    label: "Node.js",
    needs: "Always available: it runs on the board's own Node, so nothing to install.",
  },
  {
    value: "python",
    label: "Python",
    needs: "Needs Python 3 on the PATH (the py launcher on Windows). Runs isolated: no site packages.",
  },
  {
    value: "powershell",
    label: "PowerShell",
    needs: "Needs PowerShell 7 (pwsh) on the PATH, or Windows PowerShell on Windows.",
  },
  {
    value: "sh",
    label: "sh",
    needs: "Needs sh on the PATH. On Windows that is Git for Windows' or WSL's, not PowerShell.",
  },
];

export const scriptNeeds = (language: CustomScriptLanguage): string =>
  SCRIPT_LANGUAGES.find((l) => l.value === language)?.needs ?? "";

const EXTENSIONS: ReadonlyArray<readonly [RegExp, CustomScriptLanguage]> = [
  [/\.py$/i, "python"],
  [/\.(?:[cm]?js)$/i, "node"],
  [/\.ps1$/i, "powershell"],
  [/\.(?:sh|bash)$/i, "sh"],
];

/** The language a file name suggests, or null. */
export const languageOfFile = (name: string): CustomScriptLanguage | null =>
  EXTENSIONS.find(([pattern]) => pattern.test(name))?.[1] ?? null;

/** The most a loaded file may be, read as text; the script's own limit is checked on save. */
export const SCRIPT_FILE_MAX_BYTES = 200_000;

/** Whether a script is a check (prints items for agents) or an action (does something). */
export type ScriptRole = "action" | "check";

const ENV = (name: string) => customEnvName(name);

const CHECK_NOTE = [
  "Check: print one JSON object per line, one for each thing an agent should look at.",
  `"key" names the item. A key printed in an earlier run is skipped, so print everything that is still open.`,
  "Print nothing to start no agent. The other fields are free: the prompt reads them as {{item.title}}.",
];

const ACTION_NOTE = [
  "Runs in the project's folder. A non-zero exit fails the run, and what it prints is kept with it.",
];

const CONTEXT_NOTE = `The context arrives as JSON on stdin: { automation, project: { id, name, path }, inputs, task, pr }.`;

const lines = (...parts: string[]) => `${parts.join("\n")}\n`;
const commented = (prefix: string, text: readonly string[]) => text.map((t) => `${prefix} ${t}`);

/** A starting script for a language: reads the stdin context and, for a check, prints JSON lines. */
export function scriptStarter(language: CustomScriptLanguage, role: ScriptRole): string {
  const note = [...(role === "check" ? CHECK_NOTE : ACTION_NOTE), CONTEXT_NOTE];
  switch (language) {
    case "node":
      return lines(
        ...commented("//", note),
        `const context = JSON.parse(require("node:fs").readFileSync(0, "utf8"));`,
        "",
        ...(role === "check"
          ? [
              "const items = [",
              `  { key: "example-1", title: \`Something to look at in \${context.project.name}\` },`,
              "];",
              "for (const item of items) console.log(JSON.stringify(item));",
            ]
          : ["console.log(`Ran in ${context.project.name}`);"]),
      );
    case "python":
      return lines(
        ...commented("#", note),
        "import json",
        "import sys",
        "",
        "context = json.load(sys.stdin)",
        "",
        ...(role === "check"
          ? [
              "items = [",
              `    {"key": "example-1", "title": f"Something to look at in {context['project']['name']}"},`,
              "]",
              "for item in items:",
              "    print(json.dumps(item))",
            ]
          : [`print(f"Ran in {context['project']['name']}")`]),
      );
    case "powershell":
      return lines(
        ...commented("#", note),
        "$context = [Console]::In.ReadToEnd() | ConvertFrom-Json",
        "",
        ...(role === "check"
          ? [
              "$items = @(",
              `  @{ key = "example-1"; title = "Something to look at in $($context.project.name)" }`,
              ")",
              "foreach ($item in $items) { $item | ConvertTo-Json -Compress }",
            ]
          : [`Write-Output "Ran in $($context.project.name)"`]),
      );
    case "sh":
      return lines(
        ...commented("#", [
          ...(role === "check" ? CHECK_NOTE : ACTION_NOTE),
          `sh can't parse JSON: read the values from the environment ($${ENV("PROJECT_NAME")}, $${ENV("PROJECT_PATH")}, $${ENV("TASK_NUMBER")}...), or pipe stdin to jq if you have it.`,
        ]),
        "",
        ...(role === "check"
          ? [`printf '{"key":"example-1","title":"Something to look at in %s"}\\n' "$${ENV("PROJECT_NAME")}"`]
          : [`echo "Ran in $${ENV("PROJECT_NAME")}"`]),
      );
  }
}

/** Whether a script is still the unchanged starter of some language, so switching language can swap it for the new one. */
export function isStarter(body: string, role: ScriptRole): boolean {
  const text = body.trim();
  return text === "" || SCRIPT_LANGUAGES.some((l) => scriptStarter(l.value, role).trim() === text);
}

/** "1.2 s", "340 ms". */
export const formatDuration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

/** The one line a test run opens its result with, and how it reads: green only for a clean exit. */
export function testHeadline(result: Pick<TestScriptResult, "error" | "exitCode" | "timedOut" | "durationMs">): {
  tone: "success" | "error" | "warning";
  text: string;
} {
  if (result.error) return { tone: "error", text: "Couldn't run" };
  if (result.timedOut)
    return { tone: "warning", text: `Timed out after ${formatDuration(result.durationMs)} and was stopped` };
  if (result.exitCode === 0) return { tone: "success", text: `Exited 0 in ${formatDuration(result.durationMs)}` };
  const code = result.exitCode === null ? "a signal" : String(result.exitCode);
  return { tone: "error", text: `Exited with ${code} after ${formatDuration(result.durationMs)}` };
}

/** What a check's items mean for the run: how many agents would start, or why none would. */
export function itemsSummary(items: NonNullable<TestScriptResult["items"]>): string {
  if ("problem" in items) return `Not a list of items: ${items.problem}. A real run would fail and start no agent.`;
  const n = items.items.length;
  if (n === 0) return "It printed no items, so a real run would start no agent.";
  const more = items.dropped > 0 ? ` (${items.dropped} more past the limit are left out)` : "";
  return `${n} item${n === 1 ? "" : "s"}${more}. A real run starts one agent for each one it hasn't seen before.`;
}
