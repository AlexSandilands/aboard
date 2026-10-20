import {
  AUTOMATION_SDK_SCOPE,
  CUSTOM_PLACEHOLDERS,
  customEnvName,
  inputEnvName,
  variableEnvName,
  type CustomScriptLanguage,
} from "@repo/contracts";

/** Where chips insert: a script or command in a language, or an agent's prompt. */
export type InsertTarget = CustomScriptLanguage | "prompt";

/** One value a chip can insert: what it is, the text that goes in, and the other way to read it (for the tooltip). */
export interface InsertOption {
  label: string;
  text: string;
  also: string | null;
}

/** What a chip's values are, which colours it: the task's, the project's, or ones the user names. */
export type ChipTone = "task" | "project" | "own";

/** A chip over the editor: one value, or a menu of several. `empty` says why a menu has nothing in it. */
export interface InsertChip {
  label: string;
  tone: ChipTone;
  options: InsertOption[];
  empty?: string;
}

/**
 * How code reads a value: from the stdin JSON parsed into `ctx` (as every starter and example does), or from the
 * environment in sh, which can't parse JSON. A task always has its fields, but not always a pull request.
 */
export function readValue(language: CustomScriptLanguage, stdin: string, env: string): string {
  const [root = "", ...rest] = stdin.split(".");
  switch (language) {
    case "node":
      return `ctx.${root}${root === "pr" ? "?" : ""}${rest.map((k) => `.${k}`).join("")}`;
    case "python":
      return root === "pr"
        ? `(ctx['pr'] or {}).get('url', '')`
        : `ctx${[root, ...rest].map((k) => `['${k}']`).join("")}`;
    case "powershell":
      return `$ctx.${stdin}`;
    case "sh":
      return `"$${env}"`;
  }
}

const STDIN_BY_PROMPT = new Map(AUTOMATION_SDK_SCOPE.map((v) => [v.prompt, v.stdin]));

function option(target: InsertTarget, label: string, prompt: string, env: string, stdin: string): InsertOption {
  if (target === "prompt") return { label, text: prompt, also: null };
  if (target === "sh") return { label, text: readValue(target, stdin, env), also: `stdin: ${stdin}` };
  return { label, text: readValue(target, stdin, env), also: `env: ${env}` };
}

const GROUPS: { label: string; prefix: string; tone: ChipTone; task?: true }[] = [
  { label: "project", prefix: "project.", tone: "project" },
  { label: "task", prefix: "task.", tone: "task", task: true },
  { label: "pr.url", prefix: "pr.", tone: "task", task: true },
  { label: "automation", prefix: "automation.", tone: "project" },
];

/**
 * The chips for a target: the built-in values grouped (project, task, PR, automation), then the variables set on the
 * board or a project and this automation's inputs. A schedule has no task, so it gets no task or PR chips; a check's
 * agent also gets the item it was started for.
 */
export function insertChips({
  target,
  inputs,
  variables,
  hasTask = true,
  checking = false,
}: {
  target: InsertTarget;
  inputs: readonly string[];
  variables: readonly string[];
  hasTask?: boolean;
  checking?: boolean;
}): InsertChip[] {
  const chips: InsertChip[] = GROUPS.filter((g) => hasTask || !g.task).map((group) => ({
    label: group.label,
    tone: group.tone,
    options: CUSTOM_PLACEHOLDERS.filter((p) => p.key.startsWith(group.prefix)).map((p) =>
      option(target, p.label, `{{${p.key}}}`, customEnvName(p.env), STDIN_BY_PROMPT.get(`{{${p.key}}}`) ?? p.key),
    ),
  }));
  chips.push({
    label: "vars",
    tone: "own",
    options: variables.map((name) => option(target, name, `{{vars.${name}}}`, variableEnvName(name), `vars.${name}`)),
    empty: "No variables yet: add them in Settings → Autopilot, or on a project.",
  });
  if (inputs.length > 0) {
    chips.push({
      label: "inputs",
      tone: "own",
      options: inputs.map((name) => option(target, name, `{{inputs.${name}}}`, inputEnvName(name), `inputs.${name}`)),
    });
  }
  if (target === "prompt" && checking) {
    chips.push({
      label: "item",
      tone: "own",
      options: [
        { label: "The whole item", text: "{{item}}", also: null },
        { label: "Its key", text: "{{item.key}}", also: null },
        { label: "Its title", text: "{{item.title}}", also: null },
      ],
    });
  }
  return chips;
}

/** Every variable name set on the board or on any project, sorted, for the vars chip. */
export function knownVariables(
  board: readonly { name: string }[],
  projects: readonly { variables: readonly { name: string }[] }[],
): string[] {
  return [...new Set([...board, ...projects.flatMap((p) => p.variables)].map((v) => v.name))].sort();
}

/** `value` with `text` in place of [from, to), and where the cursor ends up (after `text`). */
export function applyInsert(value: string, from: number, to: number, text: string): { value: string; cursor: number } {
  return { value: value.slice(0, from) + text + value.slice(to), cursor: from + text.length };
}
