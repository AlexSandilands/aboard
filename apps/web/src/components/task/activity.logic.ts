import { TASK_STATUSES, type TaskEvent } from "@taskboard/contracts";

export type ActivityIcon =
  | "created"
  | "status"
  | "edit"
  | "note"
  | "plan"
  | "step_done"
  | "step_started"
  | "step_blocked"
  | "step"
  | "link"
  | "archive"
  | "project"
  | "delete"
  | "other";

export interface ActivityLine {
  icon: ActivityIcon;
  /** Sentence after the actor, e.g. "moved to In Progress". */
  text: string;
  /** Markdown body shown under the line (notes). */
  quote: string | null;
}

export interface ActivityContext {
  /** "1.2"-style label + current title per step id, for steps that still exist. */
  steps: ReadonlyMap<string, { label: string; title: string }>;
  projectTitle: (projectId: string) => string | undefined;
}

const STATUS_LABEL = new Map<string, string>(TASK_STATUSES.map((s) => [s.value, s.label]));
const FIELD_LABEL: Record<string, string> = { title: "title", description: "description", planContext: "plan context" };
const LINK_KIND_LABEL: Record<string, string> = { pr: "a pull request", jira: "a Jira issue", t3_thread: "a T3 Code thread", url: "a link" };

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Human sentence for one task event. Unknown types fall back to their name. */
export function describeEvent(event: TaskEvent, ctx: ActivityContext): ActivityLine {
  const p = event.payload;
  const line = (icon: ActivityIcon, text: string, quote: string | null = null): ActivityLine => ({ icon, text, quote });
  const stepName = () => {
    const id = str(p.stepId);
    const known = id ? ctx.steps.get(id) : undefined;
    if (known) return `${known.label} ${known.title}`;
    return str(p.title) ?? "a step";
  };

  switch (event.type) {
    case "created": {
      const status = STATUS_LABEL.get(str(p.status) ?? "");
      return line("created", status ? `created this in ${status}` : "created this");
    }
    case "status_changed":
      return line("status", `moved to ${STATUS_LABEL.get(str(p.to) ?? "") ?? str(p.to) ?? "?"}`);
    case "updated": {
      const fields = Array.isArray(p.fields) ? p.fields.filter((f): f is string => typeof f === "string") : [];
      const names = fields.map((f) => FIELD_LABEL[f] ?? f);
      return line("edit", names.length ? `edited the ${names.join(", ")}` : "edited the task");
    }
    case "moved_project": {
      const title = ctx.projectTitle(str(p.to) ?? "");
      return line("project", title ? `moved to project ${title}` : "moved to another project");
    }
    case "archived":
      return line("archive", "archived this");
    case "unarchived":
      return line("archive", "unarchived this");
    case "note":
      return line("note", "left a note", str(p.text));
    case "plan_set": {
      const steps = num(p.steps);
      const phases = num(p.phases);
      return line(
        "plan",
        steps !== null && phases !== null ? `set the plan (${plural(phases, "phase")}, ${plural(steps, "step")})` : "set the plan",
      );
    }
    case "phase_added":
      return line("plan", `added phase ${str(p.title) ?? ""}`.trim());
    case "phase_updated":
      return line("plan", `renamed a phase to ${str(p.title) ?? "?"}`);
    case "phase_deleted":
      return line("delete", `deleted phase ${str(p.title) ?? ""}`.trim());
    case "steps_added": {
      const count = num(p.count) ?? 1;
      return line("plan", `added ${plural(count, "step")}`);
    }
    case "step_updated": {
      const to = str(p.to);
      if (to === "done") return line("step_done", `completed ${stepName()}`);
      if (to === "in_progress") return line("step_started", `started ${stepName()}`);
      if (to === "blocked") return line("step_blocked", `marked ${stepName()} blocked`);
      if (to === "skipped") return line("step", `skipped ${stepName()}`);
      if (to === "todo") return line("step", `reopened ${stepName()}`);
      return line("edit", `edited ${stepName()}`);
    }
    case "step_moved":
      return line("step", `moved ${stepName()}`);
    case "step_deleted":
      return line("delete", `deleted step ${str(p.title) ?? ""}`.trim());
    case "link_added":
      return line("link", `linked ${LINK_KIND_LABEL[str(p.kind) ?? ""] ?? "a link"}`);
    case "link_removed":
      return line("link", `removed ${LINK_KIND_LABEL[str(p.kind) ?? ""] ?? "a link"}`);
    default:
      return line("other", event.type.replace(/[_.]+/g, " "));
  }
}
