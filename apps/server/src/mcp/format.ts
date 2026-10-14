import {
  TASK_STATUSES,
  formatPlanText,
  type Project,
  type TaskDetail,
  type TaskEvent,
  type TaskLink,
  type TaskStatus,
  type TaskSummary,
} from "@repo/contracts";

/** Plaintext renderings for agents. Compact, stable, no JSON dumps. */

export function statusLabel(status: TaskStatus): string {
  return TASK_STATUSES.find((s) => s.value === status)?.label ?? status;
}

/** "done by #4", "duplicate of #4", "won't do"; null for open tasks. */
export function resolutionText(task: Pick<TaskSummary, "resolution" | "resolvedBy">): string | null {
  const by = task.resolvedBy ? ` #${task.resolvedBy.number}` : "";
  switch (task.resolution) {
    case "completed":
      return `done by${by || " another task"}`;
    case "duplicate":
      return `duplicate of${by || " another task"}`;
    case "wont_do":
      return "won't do";
    case null:
      return null;
  }
}

export function projectLabel(project: Project | undefined): string {
  if (!project) return "unknown project";
  return project.workspaceRoot ? `${project.title} (${project.workspaceRoot})` : project.title;
}

export function linkText(link: TaskLink): string {
  const label = link.label ? ` "${link.label}"` : "";
  switch (link.kind) {
    case "pr": {
      const name = link.ref ? `${link.ref.repo}#${link.ref.number}` : "PR";
      const s = link.snapshot;
      const state = s
        ? ` (${s.state}, checks ${s.checks}${s.reviewDecision ? `, ${s.reviewDecision.replace("_", " ")}` : ""}${
            s.mergeable === "conflicting" ? ", conflicts" : ""
          })`
        : "";
      return `PR ${name}${state}${label} ${link.url}`;
    }
    case "jira":
      return `Jira ${link.ref.key}${label}${link.url !== link.ref.key ? ` ${link.url}` : ""}`;
    case "t3_thread": {
      const s = link.snapshot ? ` (${link.snapshot.title}, ${link.snapshot.status})` : "";
      return `T3 thread${s}${label} ${link.url}`;
    }
    case "url":
      return `URL${label} ${link.url}`;
  }
}

function shortLink(link: TaskLink): string {
  switch (link.kind) {
    case "pr":
      return `PR${link.ref ? ` #${link.ref.number}` : ""}${link.snapshot ? ` ${link.snapshot.state}` : ""}`;
    case "jira":
      return link.ref.key;
    case "t3_thread":
      return "T3 thread";
    case "url":
      return "link";
  }
}

/** One line per task: "#42 Title — 3/7, at 2.1 Write tests [~] · PR #12 open · ! 1 step blocked". */
export function summaryLine(task: TaskSummary): string {
  const parts: string[] = [];
  const resolution = resolutionText(task);
  if (resolution) parts.push(resolution);
  if (task.progress.total > 0) {
    const at = task.currentStep ? `, at ${task.currentStep.index} ${task.currentStep.title}` : "";
    parts.push(`${task.progress.done}/${task.progress.total}${at}`);
  } else if (task.status === "idea") {
    parts.push("no plan");
  }
  const links = task.links.map(shortLink);
  if (links.length) parts.push(links.join(", "));
  if (task.attention.length) parts.push(`! ${task.attention.map((a) => a.message).join("; ")}`);
  return `#${task.number} ${task.title}${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
}

/** Tasks grouped under status headings, in board column order. */
export function renderTaskGroups(tasks: ReadonlyArray<TaskSummary>, indent = ""): string {
  const lines: string[] = [];
  for (const { value, label } of TASK_STATUSES) {
    const inStatus = tasks.filter((t) => t.status === value);
    if (inStatus.length === 0) continue;
    lines.push(`${indent}${label} (${inStatus.length}):`);
    for (const t of inStatus) lines.push(`${indent}  ${summaryLine(t)}`);
  }
  return lines.join("\n");
}

function eventText(event: TaskEvent): string {
  const p = event.payload;
  const str = (k: string) => (typeof p[k] === "string" ? p[k] : undefined);
  let what: string;
  switch (event.type) {
    case "note":
      what = `note: ${str("text") ?? ""}`;
      break;
    case "status_changed":
      what = `status ${str("from") ?? "?"} -> ${str("to") ?? "?"}`;
      if (str("clearedResolution")) what += ` (reopened, was ${str("clearedResolution")})`;
      break;
    case "closed": {
      const by = typeof p.byTask === "number" ? ` #${p.byTask}` : "";
      what = `closed as ${str("resolution") ?? "?"}${by}`;
      break;
    }
    case "resolver_deleted":
      what = `#${typeof p.number === "number" ? p.number : "?"} "${str("title") ?? "?"}", which closed this, was deleted`;
      break;
    case "step_updated":
      what = `step "${str("title") ?? "?"}"${str("to") ? ` ${str("from") ?? "?"} -> ${str("to")}` : " edited"}`;
      break;
    case "link_added":
      what = `linked ${str("kind") ?? ""} ${str("url") ?? ""}`.trimEnd();
      break;
    default: {
      const json = Object.keys(p).length ? ` ${JSON.stringify(p)}` : "";
      what = `${event.type.replace(/_/g, " ")}${json.length > 160 ? `${json.slice(0, 157)}...` : json}`;
    }
  }
  return `${event.at.slice(0, 16).replace("T", " ")} ${event.actor}: ${what}`;
}

/** Full "where was I" rendering of a task. */
export function renderTaskDetail(
  task: TaskDetail,
  project: Project | undefined,
  opts: { events?: number } = {},
): string {
  const lines: string[] = [];
  lines.push(`#${task.number} ${task.title} [${statusLabel(task.status)}]${task.archivedAt ? " (archived)" : ""}`);
  lines.push(`Project: ${projectLabel(project)}  ·  task id: ${task.id}`);
  if (task.progress.total > 0) lines.push(`Progress: ${task.progress.done}/${task.progress.total} steps`);
  if (task.currentStep) {
    const c = task.currentStep;
    lines.push(`Current step: ${c.index} ${c.title} [${c.status}] (phase: ${c.phaseTitle})`);
  }
  const resolution = resolutionText(task);
  if (resolution) {
    const title = task.resolvedBy ? ` "${task.resolvedBy.title}"` : "";
    lines.push(`Closed: ${resolution}${title}`);
  }
  if (task.resolves.length) {
    const resolved = task.resolves.map(
      (r) => `#${r.number} ${r.title} (${r.resolution === "duplicate" ? "duplicate" : "done by this"})`,
    );
    lines.push(`Also resolved: ${resolved.join("; ")}`);
  }
  if (task.attention.length) lines.push(`Needs attention: ${task.attention.map((a) => a.message).join("; ")}`);

  if (task.description?.trim()) lines.push("", "Description:", task.description.trim());
  if (task.planContext?.trim()) lines.push("", "Plan context:", task.planContext.trim());

  lines.push("");
  if (task.phases.some((p) => p.steps.length > 0)) {
    lines.push("Plan:", formatPlanText(task.phases, task.currentStep));
    const withNotes = task.phases.flatMap((phase, pi) =>
      phase.steps.flatMap((step, si) => (step.notes?.trim() ? [`  ${pi + 1}.${si + 1}: ${step.notes.trim()}`] : [])),
    );
    if (withNotes.length) lines.push("Step notes:", ...withNotes);
  } else if (task.resolution) {
    lines.push("Plan: none.");
  } else {
    lines.push("Plan: none yet. Add one with set_plan before moving this out of Ideas.");
  }

  if (task.links.length) {
    lines.push("", "Links:");
    for (const link of task.links) lines.push(`- ${linkText(link)}`);
  }

  const limit = opts.events ?? 10;
  if (limit > 0 && task.events.length) {
    const recent = [...task.events].sort((a, b) => b.id - a.id).slice(0, limit);
    lines.push("", `Recent activity (newest first, ${recent.length} of ${task.events.length}):`);
    for (const e of recent) lines.push(`- ${eventText(e)}`);
  }
  return lines.join("\n");
}

/** Short post-mutation rendering: header, current step and the plan. */
export function renderTaskShort(task: TaskDetail, project: Project | undefined): string {
  return renderTaskDetail(task, project, { events: 0 });
}
