import {
  AUTOPILOT_START_PLANNED,
  ReviewSkillRef,
  taskHandoffPrompt,
  type AutopilotField,
  type TaskSummary,
} from "@repo/contracts";
import { z } from "zod";
import { messageOf } from "../../integrations/github.ts";
import type { Services } from "../../services/types.ts";
import { RUNNER_DEFAULTS, RUNNER_FIELDS, RUNNER_OPTION_SHAPE } from "../runnerOptions.ts";
import { defineAutomation, type ActionResult, type Candidate, type RunnerResult } from "../types.ts";

export { AUTOPILOT_START_PLANNED };

/** How often a started run looks at whether the agent has moved the task out of Planned. */
export const START_POLL_MS = 5_000;

const ConfigSchema = z.object({
  ...RUNNER_OPTION_SHAPE,
  /** The skill the agent is told to implement with; the built-in entry is the board's own workflow. */
  skill: ReviewSkillRef,
  /** The branch the agent's worktree starts from; blank is the default branch. */
  baseRef: z.string(),
  /** How long the agent has to move the task out of Planned before the run counts as not started. */
  graceMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
});
type Config = z.infer<typeof ConfigSchema>;

const DEFAULTS: Config = {
  ...RUNNER_DEFAULTS,
  skill: { source: "builtin" },
  baseRef: "",
  graceMinutes: 15,
};

const FIELDS: AutopilotField[] = [
  {
    key: "skill",
    label: "Implement skill",
    kind: "skill",
    builtinLabel: "Default workflow",
    help: "What the agent follows to do the work. The default is the board's own workflow, from the hand-off prompt.",
  },
  ...RUNNER_FIELDS,
  {
    key: "baseRef",
    label: "Start from",
    kind: "text",
    placeholder: "The default branch",
    help: "The branch the agent's worktree starts from. Blank is the project's default branch.",
  },
  {
    key: "graceMinutes",
    label: "Start grace period",
    kind: "number",
    min: 1,
    max: 1440,
    unit: "minutes",
    help: "The agent moves the task to In Progress itself. A task still in Planned after this long is flagged.",
  },
];

/** Why a task can't be started, or null when it can. The same rules decide the candidates and re-check them. */
export function notStartable(task: TaskSummary): string | null {
  if (task.kind === "epic") return "it's an epic";
  if (task.archivedAt !== null) return "it's archived";
  if (task.status !== "planned") return "it's no longer in Planned";
  if (task.autopilot !== true) return "its Autopilot flag isn't On";
  if (task.progress.total === 0) return "it has no plan";
  if (task.blocked) return "it's blocked by unfinished tasks";
  return null;
}

/** Appended to the work prompt: nobody is there to answer, and where the agent's own skill comes from. */
function unattendedNote(skill: ReviewSkillRef): string {
  const lines = [
    "",
    "You were started by Autopilot and nobody is watching this session, so you can't ask the user anything, " +
      "the Autopilot flag included. First move the task to in_progress with move_task, even if you then have to " +
      "stop; Autopilot reads a task still in Planned as not started. If you need an answer, mark the current step " +
      "blocked with a note saying what you need, and stop. Move the task to review when the work is done.",
  ];
  if (skill.source !== "builtin") {
    lines.push(`For how to implement the work, read the skill "${skill.name}" at ${skill.path} and follow it.`);
  }
  return lines.join("\n");
}

/** T3 thread statuses that mean an agent is at work: `waiting` is idle with subagents or monitors still going. */
const BUSY_THREAD = new Set(["working", "waiting", "input", "approval"]);

/**
 * How long a thread counts as working without a snapshot (just started, T3's poll hasn't seen it) or with one the poll
 * hasn't refreshed (T3 is gone, or the thread was deleted). Every live poll refreshes the snapshots of the threads it
 * sees, so a stale one means the board can't see the thread any more.
 */
const UNSEEN_MS = 10 * 60_000;

/**
 * How many agents Start planned started are still working. A headless run is a running run, which the engine counts
 * itself. A T3 run ends once its thread has started, so this counts the tasks (In Progress, In Review where the agent
 * runs its review loop, or still Planned when the thread hasn't moved them yet) whose latest Start planned run began a
 * T3 thread that is still busy: working, waiting on subagents, or waiting on the user, and not settled or archived. A
 * snapshot only counts as evidence when the live poll took it after the run ended: the launch-time poll sees a thread
 * that hasn't run yet ("idle"). Without one, or when the poll stopped refreshing it, the thread counts for ten minutes
 * from the run's end or the snapshot. The slot frees when the thread idles, finishes, fails, settles or is archived, or
 * the task is Done, archived or back in Backlog. A run that failed at the grace period still counts: its thread may yet move
 * the task.
 */
export function workingAgents(services: Services, now: Date): number {
  const at = now.getTime();
  const open = (["planned", "in_progress", "review"] as const).flatMap((status) =>
    services.tasks.summaries({ status }),
  );
  return open.filter((task) => {
    if (task.kind === "epic" || task.archivedAt !== null) return false;
    const run = services.autopilot
      .runsForTask(task.id, 20)
      .find((r) => r.automation === AUTOPILOT_START_PLANNED && !r.dryRun && r.status !== "queued");
    if (!run || run.status === "running" || run.runner !== "t3" || !run.threadUrl) return false;
    const thread = task.links.find((l) => l.kind === "t3_thread" && l.url === run.threadUrl);
    if (thread?.kind !== "t3_thread") return false;
    const { snapshot } = thread;
    if (snapshot?.archived || snapshot?.settled) return false;
    const endedAt = run.finishedAt ?? run.updatedAt;
    const reported = snapshot && thread.syncedAt !== null && Date.parse(thread.syncedAt) >= Date.parse(endedAt);
    const seenAt = reported ? thread.syncedAt! : endedAt;
    if (at - Date.parse(seenAt) >= UNSEEN_MS) return false;
    return reported ? BUSY_THREAD.has(snapshot.status) : true;
  }).length;
}

/** What the runner recorded, without the agent's answer. */
const patchOf = ({ result: _result, output: _output, ...patch }: RunnerResult) => patch;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits for the task to leave Planned, up to `deadline` (ms since the epoch). */
async function leftPlanned(services: Services, taskId: string, deadline: number): Promise<boolean> {
  for (;;) {
    if (services.tasks.summary(taskId).status !== "planned") return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(START_POLL_MS, remaining));
  }
}

const failed = (reason: string, patch: Partial<ActionResult> = {}): ActionResult => ({
  ...patch,
  status: "failed",
  error: `Autopilot couldn't start this task: ${reason}`,
  needsAttention: true,
});

/**
 * Starts an agent on Planned tasks, one per entry into Planned. Eligible: in Planned, the task's Autopilot flag On
 * (Default never starts), a plan, nothing unfinished blocking it. The engine adds the concurrency cap, quiet hours
 * and the daily caps. Tasks go in board order, and the engine takes as many as there is room for.
 *
 * The agent moves the task to In Progress itself. A run that fails, or leaves the task in Planned past the grace
 * period, is flagged on the task and notified; it is never retried, because the dedupe key holds the task's
 * `statusChangedAt`: moving it out and back into Planned is the way to try again.
 */
export const startPlanned = defineAutomation({
  key: AUTOPILOT_START_PLANNED,
  title: "Start planned tasks",
  description:
    "Starts an agent on each Planned task whose Autopilot flag is On, once it has a plan and nothing blocks it.",
  needsAgent: true,
  schema: ConfigSchema,
  fields: FIELDS,
  defaults: DEFAULTS,
  check: ({ services, projects, engine, now }) => {
    const candidates = projects.flatMap(({ project }): Candidate[] =>
      services.tasks
        .summaries({ projectId: project.id, status: "planned" })
        .filter((task) => notStartable(task) === null)
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .map((task) => ({
          dedupeKey: `start:${task.id}:${task.statusChangedAt}`,
          summary: `start #${task.number} "${task.title}"`,
          taskId: task.id,
        })),
    );
    // A dry run only previews, whatever is working.
    if (engine.dryRun) return candidates;
    // Tasks that already had their attempt (failed, or still starting) are the engine's to skip: they mustn't use up
    // the room the tasks below them need.
    const fresh = candidates.filter((c) => !services.autopilot.hasRun(AUTOPILOT_START_PLANNED, c.dedupeKey, false));
    if (fresh.length === 0) return fresh;
    // The engine's cap counts runs, which for T3 end once the thread starts: leave room for the threads still working.
    const agents = services.autopilot
      .automations()
      .filter((a) => a.needsAgent)
      .map((a) => a.key);
    const running = services.autopilot.usage(agents, new Date(0).toISOString()).active;
    return fresh.slice(0, Math.max(0, engine.maxConcurrent - running - workingAgents(services, now)));
  },
  act: async (candidate, { services, runner, run, config, boardUrl }) => {
    const task = services.tasks.summary(candidate.taskId!);
    const reason = notStartable(task);
    if (reason) return { status: "skipped", summary: `Skipped #${task.number}: ${reason}` };

    const deadline = Date.now() + config.graceMinutes * 60_000;
    const prompt = [
      taskHandoffPrompt({ task, boardUrl, mode: "work", linkedThread: true }),
      unattendedNote(config.skill),
    ].join("\n");
    let started: RunnerResult;
    try {
      started = await runner.start({
        run,
        prompt,
        tier: task.suggestedModel?.tier ?? null,
        options: config,
        ...(config.baseRef.trim() ? { workspace: { baseRef: config.baseRef.trim() } } : {}),
      });
    } catch (error) {
      // A headless run only ends when the agent does: one that hit its budget or timeout did start.
      const begun = services.tasks.summary(task.id).status !== "planned";
      return begun
        ? {
            status: "failed",
            error: `Autopilot's agent stopped before finishing: ${messageOf(error)}`,
            needsAttention: true,
          }
        : failed(messageOf(error));
    }

    // A T3 thread is only up, and has the grace period to move the task; a headless agent is over, so it either
    // moved the task or never will.
    const patch = patchOf(started);
    if (!(await leftPlanned(services, task.id, started.runner === "headless" ? Date.now() : deadline))) {
      return failed(
        `the agent didn't move #${task.number} out of Planned within ${config.graceMinutes} minutes`,
        patch,
      );
    }
    return {
      ...patch,
      summary: `Started #${task.number} ${started.runner === "headless" ? "headless" : "in T3 Code"}`,
    };
  },
});
