import {
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_START_PLANNED,
  AUTOPILOT_UNSTICK,
  type AutopilotConfig,
  type AutopilotEngineSettings,
} from "./autopilot.ts";
import { AUTOPILOT_DIGEST } from "./digest.ts";
import { describeCustomTrigger, type CustomDefinition } from "./customAutomations.ts";
import { AUTOPILOT_MERGE_EPIC_PRS } from "./delivery.ts";
import { AUTOPILOT_FIX_PRS, AUTOPILOT_REVIEW_PRS } from "./prReview.ts";
import { parseLogins } from "./repoPrReview.ts";
import { AUTOPILOT_RECURRING } from "./recurring.ts";

// One sentence per automation, read from its effective config, for the top of its detail in Settings → Autopilot:
// what it watches for and what it does, in the words the user would use. Pure, so the web and tests share it.

const AUTO_ARCHIVE = "auto_archive";
const UNBLOCK_DEPENDENTS = "unblock_dependents";

const num = (config: AutopilotConfig, key: string, fallback: number): number =>
  typeof config[key] === "number" ? config[key] : fallback;
const str = (config: AutopilotConfig, key: string, fallback: string): string =>
  typeof config[key] === "string" && config[key] !== "" ? config[key] : fallback;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "the default workflow", or "the tdd-first skill": a skill ref (`{ source, name }`) as a phrase. */
function skillPhrase(value: unknown, builtin: string): string {
  if (value && typeof value === "object" && "name" in value && typeof value.name === "string" && value.name !== "") {
    return `the ${value.name} skill`;
  }
  return builtin;
}

/** "a, b and c". */
function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A prompt's first line, cut to about 60 characters. */
function promptGist(prompt: string): string {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

function customSentence(custom: CustomDefinition): string {
  const when = describeCustomTrigger(custom.trigger);
  const action = custom.action;
  switch (action.kind) {
    case "agent": {
      const gist = promptGist(action.prompt);
      // The quote closes the sentence when the prompt's own line already ends one.
      const ask = `ask an agent: "${gist}"${/[.!?…]$/.test(gist) ? "" : "."}`;
      return action.check
        ? `${when}, run a ${action.check.language} check script and, for each item it prints, ${ask}`
        : `${when}, ${ask}`;
    }
    case "shell":
      return `${when}, run \`${promptGist(action.command)}\`.`;
    case "script":
      return `${when}, run a ${action.language} script.`;
  }
}

/**
 * What an automation does, given its effective config (defaults and every scope's keys) and, for the PR automations,
 * the engine's rounds. A custom automation is described from its trigger and action; anything unknown falls back to
 * its description.
 */
export function automationSentence(
  automation: { key: string; description: string },
  config: AutopilotConfig,
  options: { custom?: CustomDefinition | null; engine?: Pick<AutopilotEngineSettings, "prReviewRounds"> } = {},
): string {
  if (options.custom) return customSentence(options.custom);
  switch (automation.key) {
    case AUTOPILOT_START_PLANNED:
      return `When a Planned task is flagged for Autopilot, has a plan and nothing blocks it, start an agent on it following ${skillPhrase(config.skill, "the default workflow")}.`;
    case AUTOPILOT_ORCHESTRATE:
      return `Every ${plural(num(config, "everyMinutes", 30), "minute")}, if a project has work in flight, an agent looks it over: nudges or restarts stalled threads, retries failed runs${config.mayMerge === false ? "" : ", merges ready tasks flagged for auto-merge"} and flags what needs you.`;
    case AUTOPILOT_REVIEW_PRS: {
      const rounds = options.engine ? `, up to ${plural(options.engine.prReviewRounds, "round")} per PR` : "";
      const drafts = config.reviewDrafts === true ? " (drafts too)" : "";
      const tasks = `When a task's PR${drafts} gets new commits, review it with ${skillPhrase(config.skill, "the built-in review skill")} and post the findings on it as comments${rounds}.`;
      if (config.otherPrs !== true) return tasks;
      const authors = parseLogins(config.otherAuthors);
      const who = authors.length > 0 ? authors.join(", ") : "nobody yet (add authors)";
      const verdict =
        config.otherApprove === true
          ? "approve it when it is clean and the gate passes, ask for changes, or hand it to you"
          : "ask for changes or hand it to you; a clean one waits for your approval";
      return `${tasks} Also review open PRs by ${who} that no task links to: ${verdict}.`;
    }
    case AUTOPILOT_FIX_PRS: {
      const triggers = [
        config.onChecks !== false && "failing checks",
        config.onConflicts !== false && "conflicts",
        config.onChangesRequested !== false && "a review requesting changes",
        config.onComments !== false && "new review comments",
        config.onAutopilotReview !== false && "findings from Autopilot's review",
      ].filter((t): t is string => typeof t === "string");
      return triggers.length === 0
        ? "Every trigger is off, so it never fixes anything."
        : `When a task's PR has ${listPhrase(triggers)}, send an agent to fix it.`;
    }
    case AUTOPILOT_MERGE_EPIC_PRS:
      return "When a task's PR into its epic's integration branch is reviewed, green and mergeable, merge it into that branch. Never into main.";
    case AUTOPILOT_RECURRING:
      return "Make a task from a template whenever one of a project's recurring rules comes due.";
    case AUTO_ARCHIVE:
      return `Archive tasks that have been in Done for ${plural(num(config, "days", 14), "day")}, and finished epics with their tasks.`;
    case AUTOPILOT_DIGEST: {
      const days = config.weekdaysOnly === true ? "Every weekday" : "Every day";
      const what = config.mode === "summarised" ? "an agent's summary" : "a plain list";
      return `${days} at ${str(config, "time", "09:00")}, write ${what} of what changed on the board.`;
    }
    case AUTOPILOT_UNSTICK:
      return `Tell you when an In Progress task has had no activity for ${plural(num(config, "staleHours", 24), "hour")}, or its thread has waited on you for ${plural(num(config, "waitingMinutes", 30), "minute")}.`;
    case UNBLOCK_DEPENDENTS:
      return "Tell you when the last task blocking another reaches Done.";
    default:
      return automation.description;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The engine's limits in one line, for the status strip: "1 at a time · no caps · quiet 22:00–07:00 (off)". */
export function limitsSummary(
  engine: Pick<AutopilotEngineSettings, "maxConcurrent" | "dailyRunCap" | "dailySpendCapUsd" | "quietHours" | "dryRun">,
): string {
  const caps = [
    engine.dailyRunCap !== null && `${plural(engine.dailyRunCap, "run")} a day`,
    engine.dailySpendCapUsd !== null && `${usd(engine.dailySpendCapUsd)} a day`,
  ].filter((c): c is string => typeof c === "string");
  const quiet = engine.quietHours.enabled
    ? `quiet ${engine.quietHours.start}–${engine.quietHours.end}`
    : "no quiet hours";
  return [
    `${engine.maxConcurrent} at a time`,
    caps.length > 0 ? caps.join(", ") : "no caps",
    quiet,
    ...(engine.dryRun ? ["dry run"] : []),
  ].join(" · ");
}

/** Today's runs and spend for the strip: "7 runs today · $1.12". */
export function todaySummary(today: { agentRuns: number; spendUsd: number }): string {
  return `${plural(today.agentRuns, "agent run")} today · ${usd(today.spendUsd)}`;
}
