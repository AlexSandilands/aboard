import { describeCustomTrigger, type CustomAutomation } from "./customAutomations.ts";
import type { AutopilotAutomation, AutopilotRun } from "./autopilot.ts";
import { automationBundle } from "./automationBundle.ts";
import { BRAND } from "./brand.ts";

// The "Ask an agent" hand-offs on Settings → Autopilot: a prompt to paste into the user's own agent, or to start a
// T3 Code thread with. There is no chat box: the agent already has the board's MCP tools, so each prompt points it at
// the skill and the one tool that fits, and holds it to what it can do. An agent can't switch an automation on or
// change Autopilot's settings; `draft_automation` only saves a draft the user imports and turns on.

const SKILL = `${BRAND.id}-automations`;
const OUTPUT_TAIL_CHARS = 1500;
const DEFINITION_MAX_CHARS = 6000;

const boardLine = (boardUrl: string) => `Board: ${boardUrl.replace(/\/+$/, "")}/settings/autopilot`;

const HANDOVER_LINE =
  "A draft is not set up: it comes in in Preview, and I have to import it and turn it on. Give me the link to it and say so; never tell me it is active.";

const READ_SKILL_LINE = `If the ${SKILL} skill is installed, read it first: it covers the triggers, actions, placeholders, inputs and tool slots, and how to test a script.`;

/** "Ask an agent" beside + Add: write a new automation as a draft. */
export function createAutomationPrompt({ boardUrl }: { boardUrl: string }): string {
  return [
    `Let's write a custom Autopilot automation for the ${BRAND.id} task board.`,
    boardLine(boardUrl),
    "",
    `1. Ask me what should start it, what should happen and what must never happen. Ask when something is ambiguous; don't invent a Jira key, a channel or a repository (those are variables or inputs).`,
    `2. ${READ_SKILL_LINE}`,
    "3. Pick the lightest action that does the job: a script or command when a program can decide it, an agent only for judgement.",
    `4. Save it with draft_automation(automation, note) on the ${BRAND.id} MCP server. ${HANDOVER_LINE}`,
    "Don't change Autopilot's settings or any other automation: you can't, and a draft is all I need from you.",
  ].join("\n");
}

/** A custom automation's current definition as the JSON an agent can read and write back, or null for a built-in. */
function definitionOf(custom: CustomAutomation | null): string | null {
  if (!custom) return null;
  const json = JSON.stringify(automationBundle(custom), null, 2);
  return json.length > DEFINITION_MAX_CHARS
    ? `${json.slice(0, DEFINITION_MAX_CHARS)}\n… (cut: read the rest on the board)`
    : json;
}

/**
 * "Ask an agent to change this" on an automation's detail. A custom automation is changed by drafting a replacement
 * for me to review; a built-in has no draft, so the agent says which settings to change and where, and changes none.
 */
export function changeAutomationPrompt({
  boardUrl,
  automation,
  custom,
  sentence,
}: {
  boardUrl: string;
  automation: Pick<AutopilotAutomation, "key" | "title">;
  /** Its definition when it is a custom automation. */
  custom: CustomAutomation | null;
  /** What it does now, in a sentence (see automationSentence). */
  sentence: string;
}): string {
  const head = [
    `I want to change the "${automation.title}" Autopilot automation on the ${BRAND.id} task board.`,
    `${boardLine(boardUrl)}?automation=${encodeURIComponent(automation.key)}`,
    `Key: ${automation.key}${custom ? ` · id: ${custom.id}` : ""}`,
    `Today: ${sentence}`,
    "",
  ];
  const definition = definitionOf(custom);
  if (custom && definition) {
    return [
      ...head,
      `It is a custom automation (trigger: ${describeCustomTrigger(custom.trigger)}). Its definition:`,
      "```json",
      definition,
      "```",
      "",
      "1. Ask me what to change, and why, before you write anything.",
      `2. ${READ_SKILL_LINE}`,
      `3. Save the changed version as a new draft with draft_automation(automation, note) on the ${BRAND.id} MCP server, keeping what I didn't ask you to change. In the note, say what you changed. ${HANDOVER_LINE}`,
      "Importing the draft makes a new automation: tell me to switch the old one off once I have turned the new one on.",
    ].join("\n");
  }
  return [
    ...head,
    "It is a built-in automation: you can't change its settings, and draft_automation is only for custom ones.",
    "1. Ask me what I want it to do differently.",
    `2. Tell me exactly which of its settings to change on the board (Settings → Autopilot → ${automation.title}), or, when no setting does it, write a custom automation for it with draft_automation(automation, note) on the ${BRAND.id} MCP server. ${READ_SKILL_LINE} ${HANDOVER_LINE}`,
  ].join("\n");
}

/** The last `max` characters of a run's printed output, whole lines only. */
export function outputTail(text: string, max = OUTPUT_TAIL_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(-max);
  const newline = cut.indexOf("\n");
  return `… ${newline === -1 ? cut : cut.slice(newline + 1)}`;
}

/**
 * "Ask an agent to fix" on a failed run: what failed and what it printed, so the agent finds why. It may fix what it
 * owns (the automation's prompt or script as a draft, the project's setup); it doesn't retry or switch anything on.
 */
export function fixRunPrompt({
  boardUrl,
  run,
  automation,
  custom,
  task,
}: {
  boardUrl: string;
  run: Pick<AutopilotRun, "id" | "automation" | "summary" | "error" | "detail" | "exitCode" | "dryRun" | "taskId">;
  automation: Pick<AutopilotAutomation, "key" | "title">;
  custom: CustomAutomation | null;
  /** "#12 Rewrite the cart drawer", when the run was on a task. */
  task: string | null;
}): string {
  const printed = run.detail ? outputTail(run.detail) : null;
  const lines = [
    `An Autopilot run failed on the ${BRAND.id} task board and I want it fixed.`,
    `${boardLine(boardUrl)}?automation=${encodeURIComponent(automation.key)}`,
    `Automation: ${automation.title} (key: ${automation.key}${custom ? `, id: ${custom.id}` : ""})${task ? ` · on ${task}` : ""}`,
    `Run: ${run.id}${run.exitCode !== null ? ` · exit code ${run.exitCode}` : ""}${run.dryRun ? " · a Preview run" : ""}`,
    `What it said: ${run.summary}`,
    ...(run.error ? [`Error: ${run.error}`] : []),
    ...(printed ? ["Its output, last lines:", "```", printed, "```"] : []),
    "",
    "1. Find out why it failed: read the error and output above, then the task with get_task if it was on one, and the automation's prompt or script.",
    custom
      ? `2. If its prompt or script is at fault, save the corrected version as a new draft with draft_automation(automation, note) on the ${BRAND.id} MCP server. ${READ_SKILL_LINE} ${HANDOVER_LINE}`
      : `2. It is a built-in, so there is no draft to write: if a setting of mine caused it, say which one to change and where (Settings → Autopilot → ${automation.title}); if the cause is in the repo or the project's setup, fix that.`,
    run.taskId
      ? `3. Once the cause is gone, you can let it try again with retry_autopilot_run(task, automation: "${automation.key}"). Don't push an empty commit to re-trigger it.`
      : "3. Tell me what to do next; a run without a task can't be retried from here.",
    "Don't change Autopilot's settings or switch anything on: you can't, and I will.",
  ];
  return lines.join("\n");
}
