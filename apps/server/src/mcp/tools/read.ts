import { z } from "zod";
import { TaskStatus, type Project } from "@repo/contracts";
import { projectLabel, renderTaskDetail, renderTaskGroups, statusLabel, taskStructured } from "../format.ts";
import {
  findProject,
  hasProjectRef,
  projectFields,
  run,
  safeProject,
  taskField,
  textResult,
  type ToolRegistrar,
} from "../shared.ts";

/** Orientation and lookup tools: board_overview, list_projects, list_tasks, get_task. */
export const registerReadTools: ToolRegistrar = (server, { services }) => {
  server.registerTool(
    "board_overview",
    {
      title: "Board overview",
      description:
        "Cheap orientation call. Shows every project on the user's board with task counts per status " +
        "(Ideas, Planned, In Progress, Review, Done) and anything needing attention (blocked steps, failing PRs, " +
        "threads awaiting input). Pass workspacePath (your cwd) to also list that project's open tasks. " +
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
          lines.push("The board is empty. create_idea or create_task with your workspacePath to start a project.");
        }
        for (const project of snapshot.projects.filter((p) => !p.archivedAt)) {
          const tasks = active.filter((t) => t.projectId === project.id);
          const counts = ["idea", "planned", "in_progress", "review", "done"]
            .map((s) => [s, tasks.filter((t) => t.status === s).length] as const)
            .filter(([, n]) => n > 0)
            .map(([s, n]) => `${statusLabel(s as TaskStatus)} ${n}`);
          lines.push(
            `${projectLabel(project)} — ${counts.length ? counts.join(", ") : "no tasks"}  [id: ${project.id}]`,
          );
          for (const t of tasks.filter((t) => t.attention.length > 0)) {
            lines.push(`  ! #${t.number} ${t.title}: ${t.attention.map((a) => a.message).join("; ")}`);
          }
        }
        if (hasProjectRef(args)) {
          const project = findProject(services, args);
          lines.push("");
          if (!project) {
            lines.push(
              `No project for ${args.workspacePath ?? args.projectId} yet — it is created on first create_idea/create_task.`,
            );
          } else {
            const open = active.filter((t) => t.projectId === project.id && t.status !== "done");
            lines.push(`Open tasks in ${project.title}:`);
            lines.push(open.length ? renderTaskGroups(open, "  ") : "  none");
          }
        }
        const t3 = snapshot.integrations.t3;
        if (t3.detected) lines.push("", `T3 Code detected (environment ${t3.environmentId ?? "unknown"}).`);
        return textResult(lines.join("\n"), {
          projects: snapshot.projects.length,
          tasks: active.length,
        });
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
    "list_tasks",
    {
      title: "List tasks",
      description:
        "Lists tasks as compact one-line summaries grouped by status (progress, current step, links, attention). " +
        "Filter by project (workspacePath/projectId), status, free text (matches title, description, #number, Jira keys) " +
        "or attentionOnly. Use it to find the task you should resume, then call get_task.",
      inputSchema: {
        ...projectFields,
        status: TaskStatus.optional().describe("Only tasks in this status."),
        query: z.string().optional().describe("Free-text filter."),
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
          if (!project) return textResult(`No tasks yet for ${args.workspacePath ?? args.projectId}.`, { tasks: [] });
          projectId = project.id;
        }
        const tasks = services.tasks.summaries({
          ...(projectId ? { projectId } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.query ? { query: args.query } : {}),
          ...(args.attentionOnly ? { attentionOnly: true } : {}),
          ...(args.includeArchived ? { includeArchived: true } : {}),
        });
        if (tasks.length === 0) return textResult("No matching tasks.", { tasks: [] });
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
        return textResult(lines.join("\n"), {
          tasks: shown.map((t) => ({ taskId: t.id, number: t.number, title: t.title, status: t.status })),
        });
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "The 'where was I' call. Full task detail: description, plan context, every phase/step with its status " +
        "and id (1.2 [x] ...), the current step, links with live PR/thread state, and recent activity including " +
        "handover notes. ALWAYS call this before resuming work on an existing task.",
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
        return textResult(
          renderTaskDetail(task, safeProject(services, task.projectId), { events: args.events ?? 10 }),
          taskStructured(task),
        );
      }),
  );
};
