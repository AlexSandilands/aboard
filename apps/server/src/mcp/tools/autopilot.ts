import {
  actionScripts,
  AUTOMATION_DRAFT_NOTE_MAX,
  AUTOMATION_DRAFT_TTL_DAYS,
  automationDraftPath,
  canRetryRun,
  effectiveVariables,
  variableHasValue,
  variablesNamedBy,
  type AutomationDraft,
} from "@repo/contracts";
import { z } from "zod";
import { AppError } from "../../errors.ts";
import type { Services } from "../../services/types.ts";
import { actorField, boardUrl, run, taskField, taskResult, textResult, type ToolRegistrar } from "../shared.ts";

/** One line per variable the draft reads that some project has no value for, or none. */
function missingVariables(services: Services, draft: AutomationDraft): string[] {
  const board = services.settings.get().automationVariables;
  const projects = services.projects.list();
  return variablesNamedBy(draft.bundle.action).flatMap((name) => {
    const lacking = projects.filter((p) => !variableHasValue(effectiveVariables(board, p), name)).map((p) => p.title);
    if (lacking.length === 0) return [];
    return lacking.length === projects.length
      ? [`- ${name}: not set on the board or in any project`]
      : [`- ${name}: no value in ${lacking.join(", ")}`];
  });
}

/**
 * retry_autopilot_run, which lifts no limit (the engine decides whether there is still work, under the user's switches,
 * pause and caps), and draft_automation, which saves nothing that runs: only the user's import on the board's page
 * does. Neither switches Autopilot on or changes what it may do.
 */
export const registerAutopilotTools: ToolRegistrar = (server, { services, ctx, actor }) => {
  server.registerTool(
    "retry_autopilot_run",
    {
      title: "Retry a task's failed Autopilot run",
      description:
        "Let Autopilot try a task's failed or skipped run again, such as a PR review or a start that a board restart " +
        "interrupted (get_task shows it under attention or in recent activity). Clears its attention flag; on its next " +
        "pass, within a minute, the automation acts again if there is still work, under the user's switches, pause and " +
        "limits. Rounds and attempts no longer count the retried run. Use it instead of pushing an empty commit to " +
        "re-trigger a review. Retry a run once its cause is gone: one that fails the same way again wastes a run.",
      inputSchema: {
        task: taskField,
        automation: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Which automation's run, by key or title (e.g. review_prs or Review PRs). Default: the task's newest run that can be retried.",
          ),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const taskId = services.tasks.resolveId(args.task);
        const titles = new Map(services.autopilot.automations().map((a) => [a.key, a.title]));
        const wanted = args.automation?.toLowerCase();
        const runs = services.autopilot
          .runsForTask(taskId)
          .filter((r) => !r.dryRun)
          .filter((r) => !wanted || r.automation === wanted || titles.get(r.automation)?.toLowerCase() === wanted);
        // A run the same automation has run again since (its next head, its next try) is history: the service refuses it.
        const target = runs.find((r) => canRetryRun(r, runs));
        if (!target) {
          const which = args.automation ? `${args.automation} ` : "";
          throw new AppError("NOT_FOUND", `This task has no failed or skipped ${which}Autopilot run to retry.`);
        }
        const retried = services.autopilot.retry(target.id, actor(args.actor));
        const title = titles.get(retried.automation) ?? retried.automation;
        return taskResult(
          services,
          taskId,
          `Asked ${title} to try again (${target.summary}). Its next pass acts if there is still work; ` +
            "follow it in the task's activity.",
        );
      }),
  );

  server.registerTool(
    "draft_automation",
    {
      title: "Draft a custom automation for the user to import",
      description:
        'Write a custom Autopilot automation for the user when they ask for one ("every morning, ...", "when a PR ' +
        'merges, ..."). It saves nothing that runs: the board keeps it as a draft for ' +
        `${AUTOMATION_DRAFT_TTL_DAYS} days and gives you a link to its import page, where the user reads it, confirms ` +
        "any script, fills in inputs and tool slots, and imports it switched off. Give the user the link and say they " +
        "must import it and switch it on; never claim it is set up. A draft with problems is refused with every problem " +
        "listed: fix them all and call again. Each call makes a new draft.",
      inputSchema: {
        automation: z
          .record(z.string(), z.unknown())
          .describe(
            "The automation as a shared automation file (format and version are filled in). Fields: name (up to 80 " +
              "characters); description (what it does, for the user); trigger, one of {kind: 'status_change', to, " +
              "from?} (statuses backlog|planned|in_progress|review|done), {kind: 'pr_event', event: " +
              "linked|new_head|checks_failing|conflict|merged}, {kind: 'stale', status, hours}, {kind: " +
              "'blocker_finished'} or {kind: 'schedule', schedule: {kind: 'weekly', days: [0-6, 0 is Sunday], time: " +
              "'HH:MM'} | {kind: 'hourly', everyHours} | {kind: 'minutes', everyMinutes (5-1440)}}; filters: {labels} " +
              "(not for a schedule); action, one of {kind: 'agent', prompt, skill?, tier?: light|standard|deep, " +
              "onPrBranch?, allowedTools?: ['mcp__server__tool'], check?: {language, body, timeoutSeconds?}, " +
              "untrustedItems?}, {kind: 'shell', command, timeoutSeconds?} or {kind: 'script', language: " +
              "python|node|powershell|sh, body, timeoutSeconds?}; inputs: [{name, label, type: text|number|boolean, " +
              "default}] for values the user picks; slots: [{name, label, description}] for tools the agent needs from " +
              "the user's own MCP servers (agent only; never name a server in the prompt). A prompt reads " +
              "{{task.title}}, {{task.number}}, {{task.id}}, {{task.status}}, {{pr.url}}, {{project.name}}, " +
              "{{project.path}}, {{project.repo_url}}, {{automation.name}}, {{inputs.<name>}} and {{vars.<name>}} " +
              "(the user's variables, such as a Jira key); a command or script reads them as environment variables " +
              "or JSON on stdin, never as {{...}}.",
          ),
        note: z
          .string()
          .trim()
          .max(AUTOMATION_DRAFT_NOTE_MAX)
          .optional()
          .describe(
            "To the user, shown above the draft: what it is for and anything to check before importing it (tools to " +
              "fill in, variables to set).",
          ),
        actor: actorField,
      },
    },
    (args) =>
      run(() => {
        const draft = services.customAutomations.draft(
          { automation: args.automation, note: args.note ?? "" },
          actor(args.actor),
        );
        const { bundle } = draft;
        const lines = [
          `Drafted "${bundle.name}". Nothing is saved or running yet: the user must open the draft, review it and ` +
            "import it, and it comes in switched off.",
          `Import page: ${boardUrl(ctx)}${automationDraftPath(draft.id)}`,
          `It expires ${draft.expiresAt.slice(0, 10)} unless imported.`,
        ];
        if (actionScripts(bundle.action).length > 0) {
          lines.push(
            "It runs a script on the user's machine, so they must read it and confirm the script on the import page.",
          );
        } else if (bundle.action.kind === "shell") {
          lines.push("It runs a command on the user's machine, so they must read it before importing it.");
        }
        if (bundle.slots.length > 0) {
          lines.push(
            `The user fills these tool slots with their own MCP tools when importing: ${bundle.slots.map((s) => s.label).join(", ")}.`,
          );
        }
        const missing = missingVariables(services, draft);
        if (missing.length > 0) {
          lines.push(
            "Variables it reads that have no value, so it skips those projects until the user sets them (Settings → " +
              "Autopilot → Custom automations → Variables, or a project's settings):",
            ...missing,
          );
        }
        lines.push("Tell the user it is waiting for them, with the link.");
        return textResult(lines.join("\n"));
      }),
  );
};
