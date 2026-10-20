import { z } from "zod";

// Tool rules shared by custom automations and ticket systems' import tools. Kept apart from both so the settings
// schema can use them without importing customAutomations.ts, which imports schemas.ts.

/** The longest tool rule. */
export const CUSTOM_TOOL_MAX = 200;

/**
 * A tool an agent is allowed to call without asking, as Claude Code's `--allowedTools` takes it: a whole MCP
 * server (`mcp__issue-tracker`), one of its tools (`mcp__issue-tracker__search_jira`, or `mcp__issue-tracker__search_*`), or a
 * built-in tool with an optional specifier (`Skill(name)`). A `*` is only allowed in the tool part of
 * an MCP rule: Claude Code skips one in the server part.
 */
const MCP_TOOL_RULE = /^mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_*-]+)?$/;

/**
 * The built-in tools a rule may name. Not the shell tools (Bash, PowerShell, ...): the push and merge deny rules are
 * `Bash(...)` patterns, so allowing another shell tool would sidestep them, and an edit run already has Bash.
 */
export const CUSTOM_BUILT_IN_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "Skill",
] as const;
const BUILT_IN_TOOL_RULE = new RegExp(`^(?:${CUSTOM_BUILT_IN_TOOLS.join("|")})(?:\\([^()\\r\\n]+\\))?$`);

export const CustomToolRule = z
  .string()
  .trim()
  .max(CUSTOM_TOOL_MAX)
  .refine(
    (rule) => MCP_TOOL_RULE.test(rule) || BUILT_IN_TOOL_RULE.test(rule),
    "Use mcp__<server>, mcp__<server>__<tool> or a built-in tool such as WebFetch (not Bash or another shell)",
  );
