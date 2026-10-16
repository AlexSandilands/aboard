import { z } from "zod";
import {
  defaultHandoffMode,
  handoffModeError,
  suggestedModelLine,
  taskHandoffPrompt,
  TaskStatusInput,
  type HandoffMode,
  type TaskStatus,
  type Project,
  type TaskDetail,
} from "@repo/contracts";
import { AppError } from "../../errors.ts";
import {
  projectLabel,
  renderEpicChildren,
  renderTemplate,
  renderTaskDetail,
  renderTaskGroups,
  statusLabel,
  summaryLine,
} from "../format.ts";
import {
  boardUrl,
  childActivity,
  findProject,
  hasProjectRef,
  projectFields,
  run,
  safeProject,
  t3LaunchBlocker,
  taskField,
  textResult,
  type ToolRegistrar,
} from "../shared.ts";
import { openRoundPointer } from "./reviews.ts";

/**
 * The reviewer reads the task through get_task too, so this must not tell it to start a reviewer itself:
 * it only says who does what. The full loop instructions come from move_task and start_review.
 */
function withOpenRoundPointer(detail: string, task: TaskDetail): string {
  const pointer = openRoundPointer(task);
  return pointer ? `${detail}\n\n${pointer}` : detail;
}

/**
 * Orientation and lookup tools: board_overview, list_projects, list_tasks, get_task, epic_overview, and
 * get_handoff_prompt.
 */
export const registerReadTools: ToolRegistrar = (server, { services, ctx }) => {
  server.registerTool(
    "board_overview",
    {
      title: "Board overview",
      description:
        "Cheap orientation call. Shows every project on the user's board with task counts per status " +
        "(Backlog, Planned, In Progress, Review, Done) and anything needing attention (blocked steps, failing PRs, " +
        "threads awaiting input), plus the labels in use. Pass workspacePath (your cwd) to also list that project's open tasks. " +
        "Call this at the start of meaningful work.",
      inputSchema: { ...projectFields },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const snapshot = services.board.snapshot();
        const active = snapshot.tasks.filter((t) => !t.archivedAt);
        const lines: string[] = [];
        if (snapshot.projects.length === 0) {
          lines.push("The board is empty. add_to_backlog or create_task with your workspacePath to start a project.");
        }
        for (const project of snapshot.projects.filter((p) => !p.archivedAt)) {
          const inProject = active.filter((t) => t.projectId === project.id);
          // Epics group tasks rather than being work items, so they are listed apart from the counts.
          const tasks = inProject.filter((t) => t.kind !== "epic");
          const counts = ["backlog", "planned", "in_progress", "review", "done"]
            .map((s) => [s, tasks.filter((t) => t.status === s).length] as const)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${statusLabel(s as TaskStatus)} ${n}`);
          lines.push(
            `${projectLabel(project)} — ${counts.length ? counts.join(", ") : "no tasks"}  [id: ${project.id}]`,
          );
          for (const epic of inProject.filter((t) => t.kind === "epic" && t.status !== "done")) {
            lines.push(`  epic ${summaryLine(epic)}`);
          }
          for (const t of tasks.filter((task) => task.attention.length > 0)) {
            lines.push(`  ! #${t.number} ${t.title}: ${t.attention.map((a) => a.message).join("; ")}`);
          }
        }
        if (hasProjectRef(args)) {
          const project = findProject(services, args);
          lines.push("");
          if (!project) {
            lines.push(
              `No project for ${args.workspacePath ?? args.projectId} yet — it is created on first add_to_backlog/create_task.`,
            );
          } else {
            const open = active.filter((t) => t.projectId === project.id && t.status !== "done");
            lines.push(`Open tasks in ${project.title}:`);
            lines.push(open.length ? renderTaskGroups(open, "  ") : "  none");
          }
        }
        const labels = services.labels.usage();
        if (labels.length) lines.push("", `Labels in use: ${labels.map((l) => `${l.name} (${l.count})`).join(", ")}`);
        const t3 = snapshot.integrations.t3;
        if (t3.detected) lines.push("", `T3 Code detected (environment ${t3.environmentId ?? "unknown"}).`);
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists projects (swimlanes) on the board with their ids and workspace paths.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(() => {
        const projects = services.projects.list();
        if (projects.length === 0) return textResult("No projects yet.");
        return textResult(projects.map((p: Project) => `${projectLabel(p)}  [id: ${p.id}]`).join("\n"));
      }),
  );

  server.registerTool(
    "list_templates",
    {
      title: "List task templates",
      description:
        "Lists the user's task templates: starting points such as Bug, Spike and Feature, each with the title " +
        "pattern, labels and plan steps it fills in. Pass workspacePath (your cwd) to see the ones available in " +
        "that project (board-wide ones plus the project's own). Use a template by passing its name as template to " +
        "add_to_backlog or create_task. You can't create or edit templates; the user does that in Settings.",
      inputSchema: { ...projectFields },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const project = hasProjectRef(args) ? findProject(services, args) : null;
        const templates = services.templates.list(project ? { projectId: project.id } : undefined);
        // An unknown project has no templates of its own, only the board-wide ones.
        const shown = hasProjectRef(args) && !project ? templates.filter((t) => t.projectId === null) : templates;
        if (shown.length === 0) return textResult("No templates. The user can add some in Settings.");
        const projects = new Map(services.projects.list({ includeArchived: true }).map((p) => [p.id, p]));
        const text = shown.map((t) => renderTemplate(t, t.projectId ? projects.get(t.projectId) : undefined));
        return textResult(text.join("\n\n"));
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Lists tasks as compact one-line summaries grouped by status (progress, current step, links, attention). " +
        "Filter by project (workspacePath/projectId), status, labels (any of), free text (matches title, description, " +
        "#number, Jira keys, labels), epic or attentionOnly. Epics are listed too, marked [epic], and a task in one " +
        "says which. Use it to find the task you should resume, then call get_task.",
      inputSchema: {
        ...projectFields,
        status: TaskStatusInput.optional().describe("Only tasks in this status."),
        epic: z.string().min(1).optional().describe('Only the tasks in this epic: "#12", "12" or its uuid.'),
        query: z.string().optional().describe("Free-text filter."),
        labels: z
          .array(z.string().min(1))
          .optional()
          .describe('Only tasks with any of these labels, e.g. ["ui", "backend"].'),
        attentionOnly: z.boolean().optional().describe("Only tasks needing attention."),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Max tasks to show (default 100)."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        let projectId: string | undefined;
        if (hasProjectRef(args)) {
          const project = findProject(services, args);
          if (!project) return textResult(`No tasks yet for ${args.workspacePath ?? args.projectId}.`);
          projectId = project.id;
        }
        const tasks = services.tasks.summaries({
          ...(projectId ? { projectId } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.query ? { query: args.query } : {}),
          ...(args.labels?.length ? { labels: args.labels } : {}),
          ...(args.attentionOnly ? { attentionOnly: true } : {}),
          ...(args.includeArchived ? { includeArchived: true } : {}),
          ...(args.epic ? { epicId: services.tasks.resolveId(args.epic) } : {}),
        });
        if (tasks.length === 0) return textResult("No matching tasks.");
        const limit = args.limit ?? 100;
        const shown = tasks.slice(0, limit);
        const lines: string[] = [];
        if (projectId) {
          lines.push(renderTaskGroups(shown));
        } else {
          const projects = new Map(services.projects.list({ includeArchived: true }).map((p) => [p.id, p]));
          const projectIds = [...new Set(shown.map((t) => t.projectId))];
          for (const id of projectIds) {
            lines.push(`${projectLabel(projects.get(id))}:`);
            lines.push(
              renderTaskGroups(
                shown.filter((t) => t.projectId === id),
                "  ",
              ),
            );
          }
        }
        if (tasks.length > shown.length)
          lines.push(`(${tasks.length - shown.length} more — narrow the filter or raise limit)`);
        return textResult(lines.join("\n"));
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "The 'where was I' call. Full task detail: description, plan context, every phase/step with its status " +
        "and id (1.2 [x] ...), the current step, links with live PR/thread state, and recent activity including " +
        "handover notes. ALWAYS call this before resuming work on an existing task, then act on any 'Missing links' " +
        "it lists (the Jira issue, your T3 thread).",
      inputSchema: {
        task: taskField,
        events: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("How many recent activity entries to show (default 10)."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const task = services.tasks.detail(services.tasks.resolveId(args.task));
        const detail = renderTaskDetail(task, safeProject(services, task.projectId), {
          events: args.events ?? 10,
          labelsInUse: services.labels.usage(),
          ...(task.kind === "epic" ? { childActivity: childActivity(services, task) } : {}),
        });
        return textResult(withOpenRoundPointer(detail, task));
      }),
  );

  server.registerTool(
    "epic_overview",
    {
      title: "Epic overview",
      description:
        "How every task in an epic is getting on, in one call: each task's status, progress and current step, " +
        "anything needing attention (blocked steps, failing PRs, open review findings), its review round, its live " +
        "T3 thread, its latest note and its newest activity. Use it to monitor an epic's tasks, however they were " +
        "started (T3 threads, subagents or sessions the user opened), and whether T3 Code can start them " +
        "(start_task_thread). get_task on the epic shows the same list.",
      inputSchema: { task: taskField.describe('The epic: "#12", "12" or its uuid.') },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const epic = services.tasks.detail(services.tasks.resolveId(args.task));
        if (epic.kind !== "epic") {
          throw new AppError(
            "VALIDATION",
            epic.parent
              ? `#${epic.number} is a task in epic #${epic.parent.number}; call epic_overview on that`
              : `#${epic.number} is a task, not an epic; use get_task`,
          );
        }
        const project = safeProject(services, epic.projectId);
        const header = `Epic #${epic.number} ${epic.title} [${statusLabel(epic.status)}]  ·  ${projectLabel(project)}`;
        const blocker = project ? t3LaunchBlocker(ctx, project) : "its project is missing";
        const t3 = blocker
          ? `T3 Code: not available (${blocker}). Start tasks as subagents or with prompts for the user.`
          : "T3 Code: available. start_task_thread starts a task in a new thread; message_task_thread talks to it.";
        return textResult(`${header}\n${t3}\n\n${renderEpicChildren(epic, childActivity(services, epic))}`);
      }),
  );

  server.registerTool(
    "get_handoff_prompt",
    {
      title: "Get a task's hand-off prompt",
      description:
        "The prompt that starts an agent session on a task, the same one the board's Copy prompt button gives. " +
        "Use it when orchestrating an epic: pass subagent: true for the prompt to give a subagent you start (it " +
        "reports back instead of asking the user or running its own review loop; the task needs a plan first), or leave it off for a prompt the " +
        "user pastes into a new session. mode defaults to work for a subagent, else to the task's suggested one: " +
        "plan for tasks in Backlog or without a plan, work otherwise, orchestrate for an epic.",
      inputSchema: {
        task: taskField,
        mode: z
          .enum(["work", "plan", "orchestrate"])
          .optional()
          .describe("work: pick the task up. plan: shape its plan with the user. orchestrate: an epic's prompt."),
        subagent: z.boolean().optional().describe("The prompt for a subagent you start. Work mode only."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const task = services.tasks.summary(services.tasks.resolveId(args.task));
        const subagent = args.subagent ?? false;
        // A subagent only ever gets a work prompt; its orchestrator plans the task first.
        const mode: HandoffMode = args.mode ?? (subagent ? "work" : defaultHandoffMode(task));
        const problem = handoffModeError(task, mode, subagent);
        if (problem) throw new AppError("VALIDATION", problem);
        const modelTiers = services.settings.get().modelTiers;
        const prompt = taskHandoffPrompt({ task, boardUrl: boardUrl(ctx), mode, subagent, modelTiers });
        const head = `${mode[0]!.toUpperCase()}${mode.slice(1)} prompt for #${task.number}${subagent ? ", for a subagent" : ""}. Pass it on as it is:`;
        // A subagent can't switch its own model, so the suggestion goes to the orchestrator that starts it.
        const model = subagent
          ? suggestedModelLine(task, modelTiers, "Start the subagent on that model if you can choose one.")
          : null;
        const tail = model
          ? `

${model}`
          : "";
        return textResult(`${head}
---
${prompt}
---${tail}`);
      }),
  );
};
