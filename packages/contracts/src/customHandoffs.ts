import { z } from "zod";
import { AGENT_HARNESSES, startedSessionLine, type AgentHarness } from "./agentSessions.ts";
import { BRAND } from "./brand.ts";
import { taskBoardUrl } from "./handoff.ts";
import {
  describeChoice,
  INHERIT,
  profileCliEffort,
  profileCliModel,
  type ModelSettings,
  type RunModel,
} from "./modelProfiles.ts";
import type { CliEffort } from "./modelTiers.ts";
import { cliEffortFor } from "./modelTiers.ts";
import { resolveOperationChoice, type OperationModels } from "./operations.ts";
import { CustomHandoffWorkspace, HandoffTarget, TaskLink, type CustomHandoff, type TaskSummary } from "./schemas.ts";
import { StartSessionResult } from "./sessionLaunch.ts";
import { linkBranches } from "./taskBranches.ts";

// Custom hand-offs: the user's saved prompts in a task's hand-off menu (Settings → Agents → Custom hand-offs). Each
// starts a T3 Code thread or a CLI session, through the launch dialog filled in or at once. The schema is in
// schemas.ts (the settings hold the list); this file renders a prompt, says which hand-offs a task offers and what
// model one runs on. See docs/features/agent-handoff.md#custom-hand-offs.

/** What a prompt can hold, in the order the editor offers them. */
export const CUSTOM_HANDOFF_PLACEHOLDERS = [
  "{{task}}",
  "{{task.number}}",
  "{{task.title}}",
  "{{task.branch}}",
  "{{boardUrl}}",
] as const;

const PLACEHOLDER = /\{\{\s*(task|task\.number|task\.title|task\.branch|boardUrl)\s*\}\}/g;
const TASK_PLACEHOLDER = /\{\{\s*task\s*\}\}/;

/** What `{{task.branch}}` reads for a task whose links name no branch. */
export const NO_TASK_BRANCH = "(no branch yet)";

type HandoffTask = Pick<TaskSummary, "id" | "number" | "title"> &
  Partial<Pick<TaskSummary, "links" | "integrationBranch">>;

/** The CLI a target starts; null for a T3 Code thread. */
export const handoffTargetHarness = (target: HandoffTarget): AgentHarness | null =>
  target === "t3-code" ? null : target;

/** "T3 Code thread", "Claude Code session": a target as a menu or a toast names it. */
export const handoffTargetLabel = (target: HandoffTarget): string => {
  const harness = handoffTargetHarness(target);
  return harness ? `${AGENT_HARNESSES[harness].label} session` : "T3 Code thread";
};

/** The name a custom hand-off's CLI session is linked under, e.g. "Sandbox check on #164". */
export const customHandoffLabel = (handoff: Pick<CustomHandoff, "name">, task: Pick<TaskSummary, "number">): string =>
  `${handoff.name} on #${task.number}`.slice(0, 120);

/**
 * The title of a T3 Code thread a custom hand-off starts, e.g. "#164 Sandbox check · Add custom hand-offs": the
 * hand-off's name first, so several threads on one task can be told apart in T3 Code's list.
 */
export const customHandoffThreadTitle = (
  handoff: Pick<CustomHandoff, "name">,
  task: Pick<TaskSummary, "number" | "title">,
): string => `#${task.number} ${handoff.name} · ${task.title}`.slice(0, 300);

/**
 * `{{task}}`: which task this is and how to read it. Unlike the work prompt it prescribes no workflow; the hand-off's
 * own text says what to do.
 */
export function customHandoffReference(task: HandoffTask, boardUrl: string): string {
  return [
    `#${task.number} "${task.title}"`,
    `Board: ${taskBoardUrl(boardUrl, task.id)}`,
    `Call get_task("${task.id}") on the ${BRAND.id} MCP server to read it.`,
  ].join("\n");
}

/**
 * The task's branch for `{{task.branch}}`: the first of its links' branches (an open PR's first), without the epic's
 * integration branch. Null when its links name none. A session's branch needs git, so it isn't counted here.
 */
export const customHandoffBranch = (task: HandoffTask): string | null =>
  linkBranches(task.links ?? [], { exclude: [task.integrationBranch] })[0]?.name ?? null;

/**
 * A custom hand-off's first message for a task: the placeholders filled in, the task's reference line on top when the
 * prompt has no `{{task}}` (so the agent always knows which task it is on), and what the board did about linking, as
 * every board-started session is told. Values are put in as they are, in one pass: a title holding `{{task}}` stays.
 */
export function renderCustomHandoffPrompt(
  handoff: Pick<CustomHandoff, "name" | "prompt" | "target">,
  task: HandoffTask,
  boardUrl: string,
): string {
  const reference = customHandoffReference(task, boardUrl);
  const values: Record<string, string> = {
    task: reference,
    "task.number": `#${task.number}`,
    "task.title": task.title,
    "task.branch": customHandoffBranch(task) ?? NO_TASK_BRANCH,
    boardUrl: boardUrl.replace(/\/+$/, ""),
  };
  const body = handoff.prompt.trim().replace(PLACEHOLDER, (_match, key: string) => values[key]!);
  const text = TASK_PLACEHOLDER.test(handoff.prompt) ? body : [reference, body].filter(Boolean).join("\n\n");
  const harness = handoffTargetHarness(handoff.target);
  const linked = harness
    ? startedSessionLine(harness, customHandoffLabel(handoff, task))
    : "This thread is already linked to the task; don't link it again.";
  return `${text}\n\n${linked}`;
}

/** What can start here, as the hand-off menu's built-in entries are gated (canStartT3Thread, handoffClis). */
export interface HandoffAvailability {
  t3: boolean;
  clis: readonly AgentHarness[];
}

/**
 * The custom hand-offs a task's menu offers, in the user's order: those shown on its project whose target can start
 * here. None for an epic (its hand-off orchestrates its tasks), a manual task or an archived one.
 */
export function customHandoffsFor(
  task: Pick<TaskSummary, "projectId"> & Partial<Pick<TaskSummary, "kind" | "manual" | "archivedAt">>,
  handoffs: readonly CustomHandoff[] | undefined,
  availability: HandoffAvailability,
): CustomHandoff[] {
  if (task.kind === "epic" || task.manual || task.archivedAt) return [];
  return (handoffs ?? []).filter((handoff) => {
    if (handoff.projectIds && !handoff.projectIds.includes(task.projectId)) return false;
    const harness = handoffTargetHarness(handoff.target);
    return harness ? availability.clis.includes(harness) : availability.t3;
  });
}

/** The model a custom hand-off runs on for a task, as it applies to the hand-off's target. */
export interface CustomHandoffModel {
  /** The choice that applies: the hand-off's, else what a plain launch of the task takes. */
  resolved: RunModel;
  /** For a CLI target: its `--model`, or null for the CLI's default. Always null for T3 Code. */
  cliModel: string | null;
  cliEffort: CliEffort | null;
  /** Why the hand-off's own model isn't what the target starts on, else null. */
  warning: string | null;
}

/**
 * Resolves a hand-off's model like a launch with an automation's choice: the hand-off's model, else the board's Launch
 * setting, else the task's own model. The warning is about the hand-off's own choice only (a tier or custom model
 * with nothing set for the target, a model typed for another provider, a custom model since deleted); `inherit` warns
 * of nothing, as what it comes down to depends on the task.
 */
export function customHandoffModel(
  handoff: Pick<CustomHandoff, "model" | "target">,
  task: { labels: readonly string[]; suggestedModel: TaskSummary["suggestedModel"] } | null,
  settings: ModelSettings & { operationModels: OperationModels },
): CustomHandoffModel {
  const resolved = resolveOperationChoice("launch", { task, automation: [handoff.model] }, settings);
  const harness = handoffTargetHarness(handoff.target);
  // A task with nothing chosen and no tier (the light fallback) keeps the target's default, as a plain launch does.
  const profile = resolved.source === "fallback" ? null : resolved.profile;
  const typed = harness && resolved.explicit?.provider === harness ? resolved.explicit : null;
  const cliModel = harness ? (typed?.model ?? profileCliModel(profile, harness)) : null;
  const cliEffort = harness
    ? typed
      ? (cliEffortFor(harness, typed.effort) ?? null)
      : profileCliEffort(profile, harness)
    : null;

  let warning: string | null = null;
  if (handoff.model !== INHERIT) {
    const targetName = harness ? AGENT_HARNESSES[harness].label : "T3 Code";
    const fallback = harness
      ? `${targetName} starts on its default model`
      : "the thread starts on T3 Code's default model";
    const named = describeChoice(resolved) ?? "The model";
    if (resolved.source !== "automation") {
      warning = `This hand-off's model no longer exists in Settings → Agents → Models, so it starts on the task's own model.`;
    } else if (resolved.explicit && resolved.explicit.provider !== harness) {
      warning = `${named} is typed for ${AGENT_HARNESSES[resolved.explicit.provider].label}, so ${fallback}. Pick another model, or start ${AGENT_HARNESSES[resolved.explicit.provider].label} instead.`;
    } else if (resolved.profile && (harness ? !cliModel : !resolved.profile.setting.t3)) {
      const what = resolved.profile.tier ? `The ${resolved.profile.name} tier` : resolved.profile.name;
      warning = `${what} has no ${targetName} model in Settings → Agents → Models, so ${fallback}.`;
    }
  }
  return { resolved, cliModel, cliEffort, warning };
}

/** `POST /api/tasks/:id/custom-handoffs/:handoffId`: starts a hand-off without the dialog. */
export const StartCustomHandoffInput = z.object({
  /** The board's origin as the browser has it, for the prompt's links; the server's own when left out. */
  boardUrl: z.url().optional(),
  /** T3 de-duplicates launches by it, so a retry after a lost response returns the same thread. */
  commandId: z.uuid().optional(),
});
export type StartCustomHandoffInput = z.infer<typeof StartCustomHandoffInput>;

/** What starting a hand-off without the dialog did, for the toast. */
export const StartCustomHandoffResult = z.object({
  name: z.string(),
  target: HandoffTarget,
  /** The first message as sent, which the web app copies when a CLI could only take a short one. */
  prompt: z.string(),
  /** The new thread's link, for a T3 Code target. */
  link: TaskLink.nullable(),
  /** What starting the CLI did, for a CLI target. */
  session: StartSessionResult.nullable(),
  /** Where it runs. */
  workspace: CustomHandoffWorkspace,
  /** The branch it runs on or starts from, when known. */
  branch: z.string().nullable(),
  /** The hand-off asked for the task's worktree, the task has none, and a new one was made instead. */
  fellBack: z.boolean(),
  /** The model it started on, as the target names it; null for the target's default. */
  model: z.string().nullable(),
  /** Why the hand-off's model wasn't used, when it wasn't. */
  note: z.string().nullable(),
});
export type StartCustomHandoffResult = z.infer<typeof StartCustomHandoffResult>;
