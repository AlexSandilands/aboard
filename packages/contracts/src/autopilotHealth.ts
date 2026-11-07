import { z } from "zod";
import {
  AUTOPILOT_ORCHESTRATE,
  AUTOPILOT_START_PLANNED,
  AutopilotRun,
  BOARD_RESTARTED_ERROR,
  type AutopilotHint,
  type AutopilotAutomation,
  type AutopilotConfig,
  type AutopilotEngineSettings,
} from "./autopilot.ts";

// How each automation is doing: its week in numbers, the tuning hints read from them, and auto-pause
// (docs/features/autopilot.md#health-and-hints).

/** Failures in a row, in one project, after which an automation pauses itself there. */
export const AUTOPILOT_AUTO_PAUSE_FAILURES = 3;

/** Days in an automation's week: today and the six before it, in local time. */
export const AUTOMATION_WEEK_DAYS = 7;

/** Real finished runs a week lists, newest first. */
export const AUTOMATION_WEEK_LAST_RUNS = 5;

/** `POST /api/autopilot/auto-pauses/resume`: runs it there again, counting failures from now. */
export const ResumeAutoPauseInput = z.object({ automation: z.string().min(1), projectId: z.string().min(1) });
export type ResumeAutoPauseInput = z.infer<typeof ResumeAutoPauseInput>;

/**
 * How many runs failed in a row, newest first, and the newest of them. `runs` are one automation's real finished
 * runs in one project, newest first. A skipped run did nothing either way, and one the board's restart failed wasn't
 * the automation's fault, so neither counts nor breaks the streak; a success ends it.
 */
export function failureStreak(runs: ReadonlyArray<Pick<AutopilotRun, "status" | "error" | "dryRun">>): {
  count: number;
  last: string | null;
} {
  let count = 0;
  let last: string | null = null;
  for (const run of runs) {
    if (run.dryRun || run.status === "skipped" || run.status === "queued" || run.status === "running") continue;
    if (run.status === "succeeded") break;
    if ((run.error ?? "").startsWith(BOARD_RESTARTED_ERROR)) continue;
    count += 1;
    last ??= run.error;
  }
  return { count, last };
}

/** The reason an auto-pause shows. */
export const autoPauseReason = (count: number, lastError: string | null): string =>
  `Failed ${count} times in a row.${lastError ? ` The last: ${lastError}` : ""}`;

/** `GET /api/autopilot/automations/:automation/week`: an automation's last seven days, for its This week section. */
export const AutomationWeek = z.object({
  automation: z.string(),
  /** Local midnight six days ago, where the week starts. */
  since: z.string(),
  /** Real runs that acted (succeeded, failed or still going); skipped ones did nothing. */
  runs: z.number().int(),
  failed: z.number().int(),
  /** Real runs that stopped because the PR's head moved, to act on the new head. */
  deferred: z.number().int(),
  spendUsd: z.number(),
  /** What dry run recorded instead of acting. */
  wouldRun: z.number().int(),
  /** PRs Fix PRs gave up on, by attempt budget: its review and failing checks, or review comments. */
  gaveUp: z.object({ review: z.number().int(), comments: z.number().int() }),
  /** The newest give-up run of each budget this week, so a hint about them is new only once another one comes. */
  lastGaveUp: z.object({ review: z.string().nullable(), comments: z.string().nullable() }),
  /** Oldest first, one per local day ("2026-11-07"). */
  days: z.array(z.object({ date: z.string(), runs: z.number().int(), failed: z.number().int() })),
  /** Its newest real finished runs, newest first. */
  lastRuns: z.array(AutopilotRun),
});
export type AutomationWeek = z.infer<typeof AutomationWeek>;

/** `POST /api/autopilot/hints/dismiss`. */
export const DismissHintInput = z.object({ id: z.string().min(1).max(2000) });
export type DismissHintInput = z.infer<typeof DismissHintInput>;

/** Real runs of the week before Orchestrate is told it runs more often than it needs in a project. */
export const ORCHESTRATE_BUSY_RUNS = 40;
/** The most attempts the engine allows (AutopilotEngineSettings' PR rounds). */
const MAX_PR_ROUNDS = 10;
/** The longest Orchestrate interval, in minutes. */
const MAX_ORCHESTRATE_MINUTES = 1440;

export interface AutomationHintInput {
  automation: Pick<AutopilotAutomation, "key" | "title">;
  week: AutomationWeek;
  engine: Pick<AutopilotEngineSettings, "prReviewRounds" | "prCommentRounds">;
  /** Its effective config at the board scope. */
  boardConfig: AutopilotConfig;
  /**
   * Orchestrate only: its runs this week that acted since its board setting last changed. A changed interval starts
   * the count again, so the hint asks again only once the new interval has run often too.
   */
  runsSinceConfigChange?: number;
  /** Start planned only: Planned tasks with a plan that nothing blocks, in projects where it is on, by flag. */
  planned?: {
    flagged: number;
    /** Neither flagged nor switched off for Autopilot by hand: what a flag would start. */
    unflagged: ReadonlyArray<{ id: string; number: number }>;
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const taskList = (tasks: ReadonlyArray<{ number: number }>): string => {
  const refs = tasks.map((t) => `#${t.number}`);
  if (refs.length <= 3) return refs.length === 1 ? refs[0]! : `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}`;
  return `${refs.slice(0, 3).join(", ")}…`;
};

/** The prompt that hands an agent an automation's recent failures to look into. */
export function fixAutomationPrompt(
  title: string,
  runs: ReadonlyArray<Pick<AutopilotRun, "id" | "status" | "summary" | "error" | "detail" | "createdAt">>,
): string {
  const failed = runs.filter((r) => r.status === "failed");
  return [
    `The Autopilot automation "${title}" keeps failing. Find out why and fix what you can: its setup, the project, or the script or prompt it runs. Tell me what you found and what you changed.`,
    "",
    ...failed.flatMap((r) => [
      `Run ${r.id} (${r.createdAt}): ${r.error ?? r.summary}`,
      ...(r.detail ? ["Output tail:", "```", r.detail.slice(-1500), "```"] : []),
      "",
    ]),
  ]
    .join("\n")
    .trim();
}

/**
 * The hints for one automation, from its week: Fix PRs giving up at the attempt cap (raise it), a run of failures (ask
 * an agent), Start planned on with nothing flagged (flag them), and Orchestrate running often (less often).
 */
export function automationHints(input: AutomationHintInput): AutopilotHint[] {
  const { automation, week, engine, boardConfig, planned } = input;
  const hints: AutopilotHint[] = [];
  const key = automation.key;

  const budgets = [
    { budget: "review", count: week.gaveUp.review, field: "prReviewRounds", what: "on its review and failing checks" },
    { budget: "comments", count: week.gaveUp.comments, field: "prCommentRounds", what: "on review comments" },
  ] as const;
  for (const { budget, count, field, what } of budgets) {
    const cap = engine[field];
    const newest = week.lastGaveUp[budget];
    if (count < 2 || cap >= MAX_PR_ROUNDS || !newest) continue;
    hints.push({
      // Keyed by the newest give-up, not the cap: raising the cap dismisses it, and only a give-up after that (at the
      // new cap) brings it back, though the week still counts the older ones.
      id: `gave_up:${key}:${budget}:${newest}`,
      automation: key,
      tone: "warning",
      text: `Gave up on ${plural(count, "PR")} this week after running out of attempts ${what} (the limit is ${cap}).`,
      action: {
        kind: "engine",
        label: `Raise to ${cap + 1}`,
        patch: field === "prReviewRounds" ? { prReviewRounds: cap + 1 } : { prCommentRounds: cap + 1 },
      },
      done: `Attempts ${what}: ${cap} → ${cap + 1}`,
    });
  }

  const recent = week.lastRuns.slice(0, AUTOMATION_WEEK_LAST_RUNS);
  const failures = recent.filter((r) => r.status === "failed" && !(r.error ?? "").startsWith(BOARD_RESTARTED_ERROR));
  if (failures.length >= 3) {
    const errors = [...new Set(failures.map((r) => r.error).filter((e): e is string => !!e))];
    hints.push({
      id: `failing:${key}:${failures[0]!.id}`,
      automation: key,
      tone: "danger",
      text: `Failed ${failures.length} of its last ${recent.length} runs${errors.length === 1 ? `, all with “${errors[0]}”` : ""}.`,
      action: {
        kind: "ask_agent",
        label: "Ask an agent to fix",
        prompt: fixAutomationPrompt(automation.title, recent),
      },
      done: "Prompt copied: paste it into an agent session",
    });
  }

  if (key === AUTOPILOT_START_PLANNED && planned && planned.flagged === 0 && planned.unflagged.length > 0) {
    const tasks = [...planned.unflagged].sort((a, b) => a.number - b.number);
    const n = tasks.length;
    hints.push({
      id: `unflagged:${tasks.map((t) => t.id).join(",")}`,
      automation: key,
      tone: "warning",
      text: `${plural(n, "Planned task")} ${n === 1 ? "has" : "have"} a plan but ${n === 1 ? "isn't" : "aren't"} flagged for Autopilot, so this won't start ${n === 1 ? "it" : "them"}.`,
      action: { kind: "flag_tasks", label: `Flag ${taskList(tasks)}`, taskIds: tasks.map((t) => t.id) },
      done: `Flagged ${taskList(tasks)} for Autopilot`,
    });
  }

  const every = typeof boardConfig.everyMinutes === "number" ? boardConfig.everyMinutes : null;
  const busy = input.runsSinceConfigChange ?? week.runs;
  if (key === AUTOPILOT_ORCHESTRATE && every !== null && busy >= ORCHESTRATE_BUSY_RUNS) {
    const next = Math.min(every * 2, MAX_ORCHESTRATE_MINUTES);
    if (next > every) {
      hints.push({
        id: `busy:${key}:${every}`,
        automation: key,
        tone: "info",
        text: `Ran ${busy} times this week at every ${every} minutes. If most runs found nothing to do, checking every ${next} minutes costs less.`,
        action: { kind: "board_config", label: `Every ${next} minutes`, key: "everyMinutes", value: next },
        done: `Orchestrate: every ${every} → ${next} minutes`,
      });
    }
  }
  return hints;
}

/** Autopilot-wide hints: today's run or spend cap reached, so agent runs wait until tomorrow. */
export function engineHints(input: {
  engine: Pick<AutopilotEngineSettings, "dailyRunCap" | "dailySpendCapUsd">;
  today: { agentRuns: number; spendUsd: number };
  /** Today's local date, so the hint is new each day. */
  date: string;
}): AutopilotHint[] {
  const { engine, today, date } = input;
  const runs = engine.dailyRunCap !== null && today.agentRuns >= engine.dailyRunCap;
  const spend = engine.dailySpendCapUsd !== null && today.spendUsd >= engine.dailySpendCapUsd;
  if (!runs && !spend) return [];
  return [
    {
      id: `daily_cap:${date}`,
      automation: null,
      tone: "warning",
      text: runs
        ? `Today's run cap (${engine.dailyRunCap}) is reached: no agent runs start until tomorrow.`
        : `Today's spend cap ($${engine.dailySpendCapUsd}) is reached: no agent runs start until tomorrow.`,
      action: { kind: "open_limits", label: "See limits" },
    },
  ];
}
