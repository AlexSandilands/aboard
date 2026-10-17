import { TASK_STATUSES, autopilotRunEventText, type TaskEvent } from "@repo/contracts";

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
  | "review"
  | "review_clean"
  | "review_findings"
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
const FIELD_LABEL: Record<string, string> = {
  title: "title",
  description: "description",
  planContext: "plan context",
  autoReview: "auto-review setting",
  autopilot: "Autopilot flag",
};
const FINDING_STATUS_LABEL: Record<string, string> = { fixed: "fixed", wont_fix: "won't fix" };
const LINK_KIND_LABEL: Record<string, string> = {
  pr: "a pull request",
  jira: "a Jira issue",
  t3_thread: "a T3 Code thread",
  issue: "a GitHub issue",
  agent_session: "an agent session",
  url: "a link",
};

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
      const from = str(p.template) ? ` from the ${str(p.template)} template` : "";
      return line("created", status ? `created this in ${status}${from}` : `created this${from}`);
    }
    case "status_changed": {
      const to = `moved to ${STATUS_LABEL.get(str(p.to) ?? "") ?? str(p.to) ?? "?"}`;
      const merged = str(p.mergedPr);
      if (merged) return line("status", `${to} when ${merged} merged`);
      return line("status", str(p.clearedResolution) ? `reopened this and ${to}` : to);
    }
    case "closed": {
      const by = num(p.byTask);
      const text =
        str(p.resolution) === "wont_do"
          ? "closed this as won't do"
          : str(p.resolution) === "duplicate"
            ? `closed this as a duplicate${by !== null ? ` of #${by}` : ""}`
            : `closed this as done${by !== null ? ` by #${by}` : " elsewhere"}`;
      return line("status", text);
    }
    case "resolver_deleted": {
      const by = num(p.number);
      return line("delete", `deleted ${by !== null ? `#${by}` : "the task"}, which closed this`);
    }
    case "updated": {
      const fields = Array.isArray(p.fields) ? p.fields.filter((f): f is string => typeof f === "string") : [];
      const names = fields.map((f) => FIELD_LABEL[f] ?? f);
      return line("edit", names.length ? `edited the ${names.join(", ")}` : "edited the task");
    }
    case "labels_changed": {
      const list = (value: unknown) =>
        Array.isArray(value) ? value.filter((l): l is string => typeof l === "string") : [];
      const added = list(p.added);
      const removed = list(p.removed);
      const parts = [
        added.length ? `added ${plural(added.length, "label")} ${added.join(", ")}` : null,
        removed.length ? `removed ${removed.join(", ")}` : null,
      ].filter(Boolean);
      return line("edit", parts.length ? parts.join("; ") : "changed the labels");
    }
    case "delivery_changed":
      return line(
        "edit",
        str(p.delivery) === "integration"
          ? `set delivery to the integration branch${str(p.branch) ? ` ${str(p.branch)}` : ""}`
          : "set delivery to pull requests to main",
      );
    case "suggested_model_changed": {
      const tier = str(p.tier);
      return line("edit", tier ? `suggested the ${tier} model tier` : "cleared the suggested model", str(p.reason));
    }
    case "moved_project": {
      const title = ctx.projectTitle(str(p.to) ?? "");
      return line("project", title ? `moved to project ${title}` : "moved to another project");
    }
    case "restored": {
      const from = num(p.backupNumber);
      return line(
        "created",
        from !== null ? `restored this from a backup (as #${from})` : "restored this from a backup",
      );
    }
    case "archived":
    case "unarchived": {
      const withEpic = num(p.withEpic);
      const becauseTask = num(p.becauseTask);
      if (becauseTask !== null) {
        return line("archive", `unarchived this because #${becauseTask} was ${p.reopened ? "reopened" : "unarchived"}`);
      }
      return line("archive", `${event.type} this${withEpic !== null ? ` with epic #${withEpic}` : ""}`);
    }
    case "note":
      return line("note", "left a note", str(p.text));
    case "plan_set": {
      const steps = num(p.steps);
      const phases = num(p.phases);
      const deleted = Array.isArray(p.deleted) ? p.deleted.filter((d): d is string => typeof d === "string") : [];
      return line(
        "plan",
        steps !== null && phases !== null
          ? `set the plan (${plural(phases, "phase")}, ${plural(steps, "step")})`
          : "set the plan",
        deleted.length
          ? `Deleted ${plural(deleted.length, "step")}:\n\n${deleted.map((d) => `- ${d}`).join("\n")}`
          : null,
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
    case "blocker_added":
    case "blocker_removed":
    case "blocks_added":
    case "blocks_removed":
    case "blocker_deleted":
    case "blocked_deleted": {
      const other = num(p.task);
      const task = `${other !== null ? `#${other}` : "a task"}${str(p.title) ? ` ${str(p.title)}` : ""}`;
      const text = {
        blocker_added: `made this blocked by ${task}`,
        blocker_removed: `removed ${task} as a blocker`,
        blocks_added: `made this block ${task}`,
        blocks_removed: `stopped this blocking ${task}`,
        blocker_deleted: `deleted ${task}, which blocked this`,
        blocked_deleted: `deleted ${task}, which this blocked`,
      } as const;
      return line(event.type.endsWith("_deleted") ? "delete" : "link", text[event.type]);
    }
    case "review_opened": {
      const round = num(p.round);
      const why = str(p.trigger) === "move" ? " (moved to Review)" : "";
      return line("review", `opened review round ${round ?? "?"}${why}`);
    }
    case "review_submitted": {
      const counts = (typeof p.findings === "object" && p.findings !== null ? p.findings : {}) as Record<
        string,
        unknown
      >;
      const parts = Object.entries(counts).flatMap(([severity, n]) =>
        typeof n === "number" && n > 0 ? [`${n} ${severity}`] : [],
      );
      const round = num(p.round) ?? "?";
      return parts.length
        ? line("review_findings", `reviewed round ${round}: ${parts.join(", ")}`)
        : line("review_clean", `reviewed round ${round}: no findings`);
    }
    case "finding_resolved": {
      const label = str(p.finding) ?? "a finding";
      const status = str(p.status) ?? "";
      const text =
        status === "open" ? `reopened ${label}` : `marked ${label} ${FINDING_STATUS_LABEL[status] ?? status}`;
      return line(status === "fixed" ? "step_done" : "review", text, str(p.note));
    }
    case "review_status": {
      const round = num(p.round) ?? "?";
      const status = str(p.status);
      const text =
        status === "running"
          ? `started reviewing round ${round}`
          : status === "stalled"
            ? `found no reviewer for round ${round}`
            : status === "failed"
              ? `couldn't review round ${round}`
              : `reopened review round ${round}`;
      return line(status === "failed" || status === "stalled" ? "step_blocked" : "review", text, str(p.error));
    }
    case "autopilot_run":
      return line("other", autopilotRunEventText(p));
    default:
      return line("other", event.type.replace(/[_.]+/g, " "));
  }
}
