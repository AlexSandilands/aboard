import {
  customAgentPrompt,
  customAgentToolsNote,
  customArmedAt,
  customAutomationKey,
  customTaskMatches,
  customValues,
  prLinksOf,
  prOfTask,
  describeCustomTrigger,
  describeShellRun,
  latestDue,
  latestHourlySlot,
  latestMinutesSlot,
  localStamp,
  customShellEnv,
  type CustomAutomation,
  type CustomTrigger,
  type CustomData,
  type CustomValues,
  type PrChanges,
  type TaskSummary,
} from "@repo/contracts";
import { z } from "zod";
import type { RunShell } from "../integrations/shellCommand.ts";
import type { Services } from "../services/types.ts";
import { RUNNER_DEFAULTS, RUNNER_FIELDS, RUNNER_OPTION_SHAPE } from "./runnerOptions.ts";
import { defineAutomation, type ActionResult, type Automation, type Candidate, type CheckContext } from "./types.ts";

// A custom automation as a catalogue entry (docs/features/autopilot.md#custom-automations): the trigger is the check,
// the filters narrow it, and the action is an agent through the runners or a shell command in the project's folder.

const latest = (a: string | undefined, b: string | undefined): string | undefined =>
  !a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a;

// An event at the arming instant counts: the automation was there for it.
// Compared as instants: GitHub's stamps have no milliseconds, the board's do.
const after = (at: string | null | undefined, armedAt: string): boolean =>
  Boolean(at) && Date.parse(at!) >= Date.parse(armedAt);

/** The trigger's candidates on one task, before filters: a dedupe key and what it was about. */
function taskEvents(
  trigger: Exclude<CustomTrigger, { kind: "schedule" }>,
  task: TaskSummary,
  ctx: {
    armedAt: string;
    now: Date;
    from: Map<string, string | null>;
    byId: Map<string, TaskSummary>;
    prChanges: Map<string, PrChanges>;
  },
  services: Services,
): Array<{ key: string; data: CustomData; what: string }> {
  switch (trigger.kind) {
    case "status_change": {
      if (task.status !== trigger.to || !after(task.statusChangedAt, ctx.armedAt)) return [];
      if (trigger.from && ctx.from.get(task.id) !== trigger.from) return [];
      return [{ key: `status:${task.id}:${task.statusChangedAt}`, data: {}, what: `moved to ${trigger.to}` }];
    }
    case "stale": {
      // A state, not an event: a task that was already stuck when the automation was made counts.
      if (task.status !== trigger.status) return [];
      if (Date.parse(task.statusChangedAt) > ctx.now.getTime() - trigger.hours * 3_600_000) return [];
      return [{ key: `stale:${task.id}:${task.statusChangedAt}`, data: {}, what: `stale in ${trigger.status}` }];
    }
    case "blocker_finished": {
      if (task.blockedBy.length === 0 || task.blocked || task.status === "done") return [];
      const blockers = task.blockedBy.map((b) => ctx.byId.get(b.id) ?? services.tasks.summary(b.id));
      const lastDoneAt = blockers
        .map((b) => b.statusChangedAt)
        .sort()
        .at(-1)!;
      if (!after(lastDoneAt, ctx.armedAt)) return [];
      return [{ key: `unblocked:${task.id}:${lastDoneAt}`, data: {}, what: "unblocked" }];
    }
    case "pr_event":
      return prLinksOf(task).flatMap((link) => {
        const snap = link.snapshot;
        // When the board saw the fact begin (nextPrChanges), not the PR's updatedAt, which any comment moves.
        const changes = ctx.prChanges.get(link.id) ?? {};
        const data = { prLinkId: link.id };
        switch (trigger.event) {
          case "linked":
            return after(link.createdAt, ctx.armedAt) ? [{ key: `pr_linked:${link.id}`, data, what: "PR linked" }] : [];
          case "new_head":
            return snap?.headOid && after(changes.newHead, ctx.armedAt)
              ? [{ key: `pr_head:${link.id}:${snap.headOid}`, data, what: "new commits" }]
              : [];
          case "checks_failing":
            return snap?.checks === "failing" && after(changes.checksFailing, ctx.armedAt)
              ? [{ key: `pr_checks:${link.id}:${changes.checksFailing}`, data, what: "checks failing" }]
              : [];
          case "conflict":
            return snap?.mergeable === "conflicting" && after(changes.conflict, ctx.armedAt)
              ? [{ key: `pr_conflict:${link.id}:${changes.conflict}`, data, what: "merge conflict" }]
              : [];
          case "merged":
            return snap?.state === "merged" && after(changes.merged, ctx.armedAt)
              ? [{ key: `pr_merged:${link.id}`, data, what: "PR merged" }]
              : [];
        }
      });
  }
}

const AgentConfig = z.object(RUNNER_OPTION_SHAPE);

/** The catalogue entry for a custom automation. */
export function customAutomation(custom: CustomAutomation, deps: { runShell: RunShell }): Automation {
  const { trigger, filters, action } = custom;
  const isAgent = action.kind === "agent";

  const inScope = (ctx: CheckContext<Record<string, unknown>>) =>
    ctx.projects.filter(({ project }) => filters.projectIds.length === 0 || filters.projectIds.includes(project.id));

  const matches = (task: TaskSummary) => customTaskMatches(filters, task);

  const preview = (values: CustomValues, task: TaskSummary | null, services: Services): string => {
    if (action.kind === "shell") return describeShellRun(action.command, values);
    const prompt = customAgentPrompt(custom, values, task, task ? services.tasks.detail(task.id).description : null);
    const tools = customAgentToolsNote(action);
    return tools ? `${prompt}\n\n${tools}` : prompt;
  };

  const check = (ctx: CheckContext<Record<string, unknown>>): Candidate[] => {
    const { services, now } = ctx;
    const scoped = inScope(ctx);
    if (trigger.kind === "schedule") {
      const s = trigger.schedule;
      // One at a time per project: a run that outlasts the interval holds the next slot back (it isn't recorded), and
      // the latest slot then runs once it ends. The runs in flight are asked for directly, not found in the history.
      const busy = new Set(
        isAgent
          ? services.autopilot
              .status()
              .active.filter((r) => r.automation === customAutomationKey(custom.id))
              .map((r) => r.projectId)
          : [],
      );
      return scoped.flatMap(({ project }): Candidate[] => {
        const armedAt = customArmedAt(custom, { projectId: project.id });
        const slot =
          s.kind === "hourly"
            ? latestHourlySlot(s.everyHours, now)
            : s.kind === "minutes"
              ? latestMinutesSlot(s.everyMinutes, now)
              : latestDue(s, now, localStamp(new Date(armedAt)));
        if (!slot || slot.getTime() <= Date.parse(armedAt)) return [];
        if (busy.has(project.id)) return [];
        const stamp = localStamp(slot);
        return [
          {
            dedupeKey: `schedule:${project.id}:${stamp}`,
            summary: `run "${custom.name}" in ${project.title} (${stamp.replace("T", " ").slice(0, 16)})`,
            projectId: project.id,
            data: {} satisfies CustomData,
            preview: preview(customValues(custom, project, null), null, services),
          },
        ];
      });
    }
    // The same for every project, so read once per pass.
    const ownEpics = services.autopilot.epicsWithOwnSetting({ key: customAutomationKey(custom.id) });
    return scoped.flatMap(({ project }) => {
      const tasks = services.tasks.summaries({ projectId: project.id });
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const eligible = tasks.filter(matches);
      const scopeChanged = services.customAutomations.scopeChangedAt([
        ...eligible.map((t) => t.id),
        ...new Set(eligible.flatMap((t) => (t.parent ? [t.parent.id] : []))),
      ]);
      const prChanges =
        trigger.kind === "pr_event"
          ? services.links.prChanges(eligible.flatMap((t) => prLinksOf(t).map((l) => l.id)))
          : new Map<string, PrChanges>();
      const from =
        trigger.kind === "status_change" && trigger.from
          ? services.customAutomations.statusFrom(eligible.filter((t) => t.status === trigger.to).map((t) => t.id))
          : new Map<string, string | null>();
      return eligible.flatMap((task) =>
        taskEvents(
          trigger,
          task,
          {
            armedAt: customArmedAt(custom, {
              projectId: project.id,
              epicId: task.parent?.id,
              epicOwnSetting: Boolean(task.parent && ownEpics.has(task.parent.id)),
              joinedAt: latest(scopeChanged.get(task.id), task.parent ? scopeChanged.get(task.parent.id) : undefined),
            }),
            now,
            from,
            byId,
            prChanges,
          },
          services,
        ).map(({ key, data, what }): Candidate => {
          // Only build the preview (it reads the task's detail) for candidates the engine hasn't seen yet.
          const fresh = !services.autopilot.hasRun(customAutomationKey(custom.id), key, ctx.engine.dryRun);
          return {
            dedupeKey: key,
            summary: `${isAgent ? "start an agent on" : `run "${custom.name}" for`} #${task.number} (${what})`,
            taskId: task.id,
            data,
            ...(fresh && ctx.engine.dryRun
              ? { preview: preview(customValues(custom, project, task, data), task, services) }
              : {}),
          };
        }),
      );
    });
  };

  return defineAutomation({
    key: customAutomationKey(custom.id),
    title: custom.name,
    description: `${describeCustomTrigger(trigger)}: ${isAgent ? "start an agent" : "run a shell command"}.`,
    needsAgent: isAgent,
    background: !isAgent,
    // A schedule has no task, so an epic has nothing to switch.
    epicScope: trigger.kind !== "schedule",
    schema: isAgent ? AgentConfig : z.object({}),
    fields: isAgent ? RUNNER_FIELDS : [],
    defaults: isAgent ? RUNNER_DEFAULTS : {},
    check,
    async act(candidate, ctx): Promise<ActionResult> {
      const { services } = ctx;
      const data = (candidate.data ?? {}) as CustomData;
      const task = candidate.taskId ? services.tasks.summary(candidate.taskId) : null;
      const projectId = task?.projectId ?? candidate.projectId;
      const project = projectId ? services.projects.get(projectId) : null;
      const values = customValues(custom, project, task, data);

      if (action.kind === "agent") {
        if (!task) {
          // A schedule: no task, so the runner starts it headless in an empty temp folder (never the project's own
          // checkout, which the board may be running from, so T3 Code is no option); `repo` gives it the push guard.
          const where = project?.title ?? "the board";
          const result = await ctx.runner.start({
            run: ctx.run,
            label: `${custom.name} · ${where}`,
            prompt: customAgentPrompt(custom, values, null, null),
            tier: action.tier,
            options: { ...ctx.config, runner: "headless" },
            ...(action.allowedTools.length > 0 ? { tools: action.allowedTools } : {}),
            repo: project?.workspaceRoot ?? null,
          });
          const { result: _final, output: _output, ...patch } = result;
          return { ...patch, summary: `Started an agent for "${custom.name}" in ${where}` };
        }
        const prompt = customAgentPrompt(custom, values, task, services.tasks.detail(task.id).description);
        const branch = action.onPrBranch ? (prOfTask(task, data.prLinkId)?.snapshot?.headRef ?? null) : null;
        const result = await ctx.runner.start({
          run: ctx.run,
          label: `${custom.name} · #${task.number}`,
          prompt,
          tier: action.tier ?? task.suggestedModel?.tier ?? null,
          options: ctx.config,
          // Makes the run headless: a T3 thread can't be given extra tools. The push and merge deny rules still apply.
          ...(action.allowedTools.length > 0 ? { tools: action.allowedTools } : {}),
          ...(branch ? { workspace: { branch } } : {}),
        });
        const { result: _final, output: _output, ...patch } = result;
        return { ...patch, summary: `Started an agent on #${task.number} for "${custom.name}"` };
      }

      if (!project?.workspaceRoot) {
        throw new Error(`${project?.title ?? "The project"} has no workspace folder to run "${custom.name}" in`);
      }
      const ran = await deps.runShell({
        command: action.command,
        cwd: project.workspaceRoot,
        env: customShellEnv(values),
        timeoutMs: action.timeoutSeconds * 1000,
      });
      const where = task ? ` for #${task.number}` : ` in ${project.title}`;
      const base = { detail: ran.output || null, exitCode: ran.exitCode };
      if (ran.timedOut) {
        return {
          ...base,
          status: "failed",
          summary: `"${custom.name}"${where} timed out`,
          error: `The command didn't finish within ${action.timeoutSeconds} seconds and was stopped`,
          needsAttention: task !== null,
        };
      }
      if (ran.exitCode !== 0) {
        return {
          ...base,
          status: "failed",
          summary: `"${custom.name}"${where} exited with ${ran.exitCode ?? "a signal"}`,
          error: `The command exited with ${ran.exitCode ?? "a signal"}`,
          needsAttention: task !== null,
        };
      }
      return { ...base, summary: `Ran "${custom.name}"${where}` };
    },
  });
}
