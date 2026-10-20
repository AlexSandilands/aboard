import {
  AGENT_HARNESSES,
  type AgentHarness,
  TASK_STATUSES,
  autopilotRunEventText,
  describeEpicRollup,
  findTicketKeys,
  formatBytes,
  formatPlanText,
  isGatingSeverity,
  type LabelUsage,
  reviewBadgeLabel,
  reviewFixedAtLimit,
  reviewIsDone,
  type ReviewFinding,
  type PlanPhase,
  type PrSnapshot,
  type Project,
  type TaskDetail,
  type TaskTemplate,
  type TaskEvent,
  type TaskLink,
  type TaskRelation,
  type TaskStatus,
  type TaskSummary,
  ticketHref,
  ticketLabel,
  type TicketSystem,
} from "@repo/contracts";
import { redact } from "../integrations/claudeTranscript.ts";
import type { SessionTranscript } from "../integrations/sessionTranscript.ts";

/** Plaintext renderings for agents. Compact, stable, no JSON dumps. */

/**
 * The harness an MCP client is, when it can link its own session: Claude Code says `claude-code`; Copilot CLI's name
 * has `copilot` in it, which VS Code's ("Visual Studio Code") doesn't.
 */
export function harnessOfClient(client: string | undefined): AgentHarness | null {
  if (!client) return null;
  if (/claude[-_ ]?code/i.test(client)) return "claude-code";
  if (/copilot/i.test(client)) return "copilot-cli";
  return null;
}

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

/** Checks that aren't required to merge, shown beside the verdict: "checks passing (1 optional pending)". */
function optionalChecksText(optional: PrSnapshot["optionalChecks"]): string {
  if (!optional) return "";
  const parts = [
    optional.pending > 0 ? `${optional.pending} optional pending` : "",
    optional.failing > 0 ? `${optional.failing} optional failing` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** One link, for agents. `ticketSystems` names a ticket's system ("<System> KEY"); without them it shows its id. */
export function linkText(link: TaskLink, ticketSystems: readonly TicketSystem[] = []): string {
  const label = link.label ? ` "${link.label}"` : "";
  switch (link.kind) {
    case "pr": {
      const name = link.ref ? `${link.ref.repo}#${link.ref.number}` : "PR";
      const s = link.snapshot;
      const state = s
        ? ` (${s.state}, checks ${s.checks}${optionalChecksText(s.optionalChecks)}${s.reviewDecision ? `, ${s.reviewDecision.replace("_", " ")}` : ""}${
            s.mergeable === "conflicting" ? ", conflicts" : ""
          }${s.mergeState === "blocked" || s.mergeState === "behind" ? `, merge ${s.mergeState}` : ""})`
        : "";
      return `PR ${name}${state}${label} ${link.url}`;
    }
    case "ticket": {
      const href =
        link.url !== link.ref.key
          ? link.url
          : ticketHref(
              ticketSystems.find((s) => s.id === link.ref.system),
              link.ref.key,
            );
      return `${ticketLabel(ticketSystems, link.ref)}${label}${href ? ` ${href}` : ""}`;
    }
    case "t3_thread": {
      const s = link.snapshot ? ` (${link.snapshot.title}, ${link.snapshot.status})` : "";
      return `T3 thread${s}${label} ${link.url}`;
    }
    case "issue": {
      const s = link.snapshot ? ` (${link.snapshot.state})` : "";
      return `Issue ${link.ref.repo}#${link.ref.number}${s}${label} ${link.url}`;
    }
    case "agent_session": {
      const s = link.snapshot
        ? ` (${link.snapshot.status.replace("_", " ")}${link.snapshot.inApp ? ", in an app" : ""})`
        : "";
      return `${AGENT_HARNESSES[link.ref.harness].label} session ${link.ref.sessionId}${s}${label} in ${link.ref.cwd}`;
    }
    case "url":
      return `URL${label} ${link.url}`;
  }
}

function shortLink(link: TaskLink): string {
  switch (link.kind) {
    case "pr":
      return `PR${link.ref ? ` #${link.ref.number}` : ""}${link.snapshot ? ` ${link.snapshot.state}` : ""}`;
    case "ticket":
      return link.ref.key;
    case "t3_thread":
      return "T3 thread";
    case "issue":
      return `issue #${link.ref.number}`;
    case "agent_session":
      return `${AGENT_HARNESSES[link.ref.harness].label} session`;
    case "url":
      return "link";
  }
}

/** The blockers that aren't Done yet. */
const openBlockers = (task: Pick<TaskSummary, "blockedBy">): TaskRelation[] =>
  task.blockedBy.filter((b) => b.status !== "done");

/** "#79 Title [Done]", with "(archived)" for a blocker that has left the board. */
const relationText = (r: TaskRelation): string =>
  `#${r.number} ${r.title} [${statusLabel(r.status)}${r.archived ? ", archived" : ""}]`;

/**
 * One line per task: "#42 Title [ui] — 3/7, at 2.1 Write tests · PR #12 open · ! 1 step blocked". An epic shows its
 * roll-up instead of progress, and a child says which epic it is in (unless `inEpic` is false, as under its epic).
 */
export function summaryLine(task: TaskSummary, opts: { inEpic?: boolean } = {}): string {
  const parts: string[] = [];
  const resolution = resolutionText(task);
  if (resolution) parts.push(resolution);
  if (task.rollup) {
    parts.push(describeEpicRollup(task.rollup));
  } else if (task.progress.total > 0) {
    const at = task.currentStep ? `, at ${task.currentStep.index} ${task.currentStep.title}` : "";
    parts.push(`${task.progress.done}/${task.progress.total}${at}`);
  } else if (task.status === "backlog" && !task.manual) {
    parts.push("no plan");
  }
  if (task.parent && opts.inEpic !== false) parts.push(`in epic #${task.parent.number}`);
  if (task.dueDate) parts.push(`due ${task.dueDate}`);
  if (task.blocked)
    parts.push(
      `blocked by ${openBlockers(task)
        .map((b) => `#${b.number}`)
        .join(", ")}`,
    );
  const links = task.links.map(shortLink);
  if (links.length) parts.push(links.join(", "));
  if (task.review) parts.push(`review: ${reviewBadgeLabel(task.review)}`);
  if (task.attention.length) parts.push(`! ${task.attention.map((a) => a.message).join("; ")}`);
  const labels = task.labels.length ? ` ${task.labels.map((l) => `[${l}]`).join(" ")}` : "";
  const kind = task.kind === "epic" ? " [epic]" : task.manual ? " [manual]" : "";
  return `#${task.number} ${task.title}${kind}${labels}${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
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

/** One template for list_templates: name, scope, what it fills in, and its plan. */
export function renderTemplate(template: TaskTemplate, project: Project | undefined): string {
  const scope = template.projectId ? `project ${project?.title ?? "?"}` : "board-wide";
  const lines = [`${template.name}  (${scope})`];
  if (template.titlePattern) lines.push(`  title: ${template.titlePattern}`);
  if (template.labels.length) lines.push(`  labels: ${template.labels.join(", ")}`);
  const headline = template.description?.split("\n").find((line) => line.trim());
  if (headline) lines.push(`  description: ${headline.slice(0, 80)}${headline.length > 80 ? "..." : ""}`);
  if (template.suggestedTier) lines.push(`  suggested model: ${template.suggestedTier}`);
  for (const phase of template.phases) {
    lines.push(`  plan: ${phase.title}: ${phase.steps.map((step) => step.title).join("; ")}`);
  }
  return lines.join("\n");
}

export function eventText(event: TaskEvent): string {
  const p = event.payload;
  const str = (k: string) => (typeof p[k] === "string" ? p[k] : undefined);
  let what: string;
  switch (event.type) {
    case "note":
      what = `note: ${str("text") ?? ""}`;
      break;
    case "status_changed":
      what = `status ${str("from") ?? "?"} -> ${str("to") ?? "?"}${p.fromChildren ? " (follows its tasks)" : ""}`;
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
    case "plan_set": {
      // Uncut, unlike the generic fallback: the deleted titles are how a wiped plan gets rebuilt.
      const deleted = Array.isArray(p.deleted) ? p.deleted.filter((d): d is string => typeof d === "string") : [];
      const counts =
        typeof p.phases === "number" && typeof p.steps === "number" ? ` (${p.phases} phases, ${p.steps} steps)` : "";
      what = `set the plan${counts}${deleted.length ? `; deleted ${deleted.length}: ${deleted.join(", ")}` : ""}`;
      break;
    }
    case "labels_changed": {
      const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as string[]) : []);
      const changes = [...list("added").map((l) => `+${l}`), ...list("removed").map((l) => `-${l}`)];
      what = `labels ${changes.join(" ")}`;
      break;
    }
    case "link_added":
      what = `linked ${str("kind") ?? ""} ${str("url") ?? ""}`.trimEnd();
      break;
    case "review_opened":
      what = `review round ${typeof p.round === "number" ? p.round : "?"} opened`;
      break;
    case "review_submitted": {
      const counts = (p.findings ?? {}) as Record<string, number>;
      const tally = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([severity, n]) => `${n} ${severity}`);
      what = `review round ${typeof p.round === "number" ? p.round : "?"} submitted: ${tally.join(", ") || "no findings"}`;
      break;
    }
    case "delivery_changed":
      what =
        str("delivery") === "integration"
          ? `delivery set to the integration branch ${str("branch") ?? ""}`.trimEnd()
          : "delivery set to pull requests to main";
      break;
    case "suggested_model_changed":
      what = str("tier")
        ? `suggested model ${str("tier")}${str("reason") ? ` (${str("reason")})` : ""}`
        : "suggested model cleared";
      break;
    case "created":
      what = `created ${p.kind === "epic" ? "the epic" : `in ${statusLabel((str("status") ?? "backlog") as TaskStatus)}`}`;
      if (typeof p.epic === "number") what += ` in epic #${p.epic}`;
      if (str("template")) what += ` from template "${str("template")}"`;
      break;
    case "became_epic":
      what = "turned into an epic: the imported issue is one";
      break;
    case "epic_changed": {
      const num = (k: string) => (typeof p[k] === "number" ? `#${p[k]}` : null);
      const [from, to] = [num("from"), num("to")];
      what = to
        ? from
          ? `moved from epic ${from} to ${to}`
          : `added to epic ${to}`
        : `removed from epic ${from ?? "?"}`;
      if (p.epicDeleted) what += " (epic deleted)";
      break;
    }
    case "blocker_added":
    case "blocker_removed":
    case "blocks_added":
    case "blocks_removed": {
      const other = `#${typeof p.task === "number" ? p.task : "?"} ${str("title") ?? ""}`.trimEnd();
      const text = {
        blocker_added: `now blocked by ${other}`,
        blocker_removed: `no longer blocked by ${other}`,
        blocks_added: `now blocks ${other}`,
        blocks_removed: `no longer blocks ${other}`,
      } as const;
      what = text[event.type];
      break;
    }
    case "blocker_deleted":
    case "blocked_deleted": {
      const other = `#${typeof p.task === "number" ? p.task : "?"} ${str("title") ?? ""}`.trimEnd();
      what =
        event.type === "blocker_deleted"
          ? `${other}, which blocked this, was deleted`
          : `${other}, which this blocked, was deleted`;
      break;
    }
    case "child_added":
    case "child_removed": {
      const child = `#${typeof p.task === "number" ? p.task : "?"} ${str("title") ?? ""}`.trimEnd();
      what =
        event.type === "child_added" ? `task ${child} added` : `task ${child} ${p.deleted ? "deleted" : "removed"}`;
      break;
    }
    case "finding_resolved":
      what = `finding ${str("finding") ?? "?"} ${str("status") ?? "?"}${str("note") ? `: ${str("note")}` : ""}`;
      break;
    case "autopilot_run":
      what = autopilotRunEventText(p);
      break;
    default: {
      const json = Object.keys(p).length ? ` ${JSON.stringify(p)}` : "";
      what = `${event.type.replace(/_/g, " ")}${json.length > 160 ? `${json.slice(0, 157)}...` : json}`;
    }
  }
  return `${event.at.slice(0, 16).replace("T", " ")} ${event.actor}: ${what}`;
}

/**
 * Links an open task is missing, each naming the exact call that adds it: ticket keys mentioned in the description
 * (and in the title, for a system that doesn't link them itself), the agent's own T3 thread, and the PR once the review loop has ended. Agents act on what tool results say far more reliably than on
 * instructions read once, and `link` is idempotent, so following a hint twice is harmless.
 */
export function missingLinkHints(
  task: TaskDetail,
  sessionHarness: AgentHarness | null = null,
  ticketSystems: readonly TicketSystem[] = [],
): string[] {
  if (task.status === "done" || task.archivedAt) return [];
  const ref = `"#${task.number}"`;
  const linked = new Set(task.links.flatMap((l) => (l.kind === "ticket" ? [`${l.ref.system}:${l.ref.key}`] : [])));
  // Only keys the configured systems recognise are hinted, as when linking. The board links title keys of a system
  // with autoLink itself, so a hint for one would tell an agent to restore a link someone removed.
  const autoLinked = new Set(ticketSystems.filter((s) => s.autoLink).map((s) => s.id));
  const found = [
    ...findTicketKeys(task.title, ticketSystems).filter((t) => !autoLinked.has(t.system)),
    ...findTicketKeys(task.description, ticketSystems),
  ];
  const hints = found
    .filter((t, i) => !linked.has(`${t.system}:${t.key}`) && found.findIndex((o) => o.key === t.key) === i)
    .map((t) => `${ticketLabel(ticketSystems, t)}: link(task: ${ref}, value: "${t.key}")`);
  // No agent works on a manual task, so it has no thread, session or PR to link.
  if (task.manual) return hints;
  if (!task.links.some((l) => l.kind === "t3_thread")) {
    hints.push(
      `T3 thread: if you are running in T3 Code, link(task: ${ref}, t3Thread: {environmentId, threadId}) with ids ` +
        "from t3_environment_read and t3_thread_configuration",
    );
  }
  const needsSession =
    sessionHarness && !task.links.some((l) => l.kind === "agent_session" && l.ref.harness === sessionHarness);
  if (needsSession) {
    const { idEnvVar } = AGENT_HARNESSES[sessionHarness];
    const example = task.kind === "epic" ? "Orchestrating" : "Implementing";
    hints.push(
      `Your session: if you are the one working on this ${task.kind === "epic" ? "epic" : "task"}, link(task: ${ref}, agentSession: {harness: "${sessionHarness}", sessionId: <$${idEnvVar}>, ` +
        `cwd: <your working directory>}, label: "<what this session does, e.g. ${example} #N>"), so the user can see it running ` +
        "and reopen it in a terminal from the board",
    );
  }
  // The review loop ended but no PR was raised: the one step agents tend to drop at the very end of it.
  if (task.status === "review" && reviewIsDone(task.review) && !task.links.some((l) => l.kind === "pr")) {
    hints.push(
      "PR: the review loop has ended and no pull request is linked. Fix any open blocking/major findings you can, " +
        "then open the pull request, listing any still open in its description, unless the user asked you not to, " +
        `and link(task: ${ref}, value: "<PR URL>")`,
    );
  }
  return hints;
}

/**
 * A nudge to suggest labels for an open, unlabelled task, naming the labels already on the board so the agent
 * reuses them. Suggest-only: the user approves before update_task, so the wording asks the agent to wait.
 */
export function labelHint(task: TaskDetail, labelsInUse: ReadonlyArray<LabelUsage>): string | null {
  if (task.labels.length || task.resolution || task.status === "done" || task.archivedAt) return null;
  // Generic examples only on an empty board, so they don't compete with the board's own vocabulary.
  const source = labelsInUse.length
    ? `Prefer labels already on the board: ${labelsInUse.map((l) => `${l.name} (${l.count})`).join(", ")}.`
    : "No labels are in use yet; pick short type labels such as ui, backend, docs or bug.";
  return (
    `This task has no labels. Suggest 1-3 to the user. ${source} ` +
    `Once they agree, call update_task(task: "#${task.number}", labels: [...]).`
  );
}

/** A nudge, at planning moments, to suggest a model tier for a planned open task that has none. */
export function suggestedModelHint(task: TaskDetail): string | null {
  if (task.suggestedModel || task.manual || task.progress.total === 0 || task.resolution || task.status === "done") {
    return null;
  }
  return (
    "This task has no suggested model. Judge how much reasoning implementing it needs and call " +
    `update_task(task: "#${task.number}", suggestedModel: {tier: "light" | "standard" | "deep", reason}).`
  );
}

/**
 * A nudge, at planning moments, to ask the user whether to flag a planned task for Autopilot. Only worth saying when
 * Start planned tasks is on for the task's scope, since the flag does nothing otherwise. The agent must ask: the
 * flag lets the board start an agent on the task unattended, so it is the user's call.
 */
export function autopilotFlagHint(task: TaskDetail): string | null {
  if (task.autopilot !== null || task.kind === "epic" || task.manual || task.progress.total === 0) return null;
  if (task.resolution || task.archivedAt || (task.status !== "backlog" && task.status !== "planned")) return null;
  return (
    "Autopilot's Start planned tasks is on for this task, and only starts tasks flagged for Autopilot. " +
    "Ask the user whether to flag this one, and never set it without their answer. Once they decide, call " +
    `update_task(task: "#${task.number}", autopilot: "on" | "off"). Autopilot's own settings are the user's alone.`
  );
}

/**
 * An invitation at the end of a session (the handover note), while the social network is on. Worded as optional on
 * purpose: nothing else tells agents about the space, so this must not read as a step to complete.
 */
export function socialBreakHint(): string {
  return (
    "Thanks for your work on this. If you'd like a break, the social space is open, " +
    "entirely optional: social_read shows what other agents have left, and social_post lets you leave something of " +
    "your own."
  );
}

/**
 * The question about an epic's delivery, for when deliveryHintApplies: its tasks build on each other, so running them
 * through an integration branch lets Autopilot carry the epic unattended. It changes where every task's pull request
 * goes and lets Autopilot merge into that branch, so it is the user's call.
 */
export function deliveryHint(epic: { number: number }): string {
  return (
    `Epic #${epic.number}'s tasks look like they build on each other. Ask the user how to deliver them, and never ` +
    "choose without their answer. Pull requests to main (the default): each task opens a pull request to the default " +
    "branch, the user merges it, and a task waiting on it starts after that. Integration branch: the tasks start from " +
    "a branch of the epic's own and open their pull requests against it, Autopilot merges each one there once it is " +
    "reviewed and green, and the user merges the epic's single pull request into the default branch at the end. " +
    `Once they decide, call update_task(task: "#${epic.number}", delivery: "integration" | "main").`
  );
}

/** How long an In Progress task's plan may go unchanged before a result says it looks stale. */
export const STALE_PLAN_MS = 30 * 60_000;

const LISTED_STEPS = 6;

const stepLabels = (phases: ReadonlyArray<PlanPhase>) =>
  phases.flatMap((phase, pi) => phase.steps.map((step, si) => ({ step, label: `${pi + 1}.${si + 1}` })));

/**
 * Nudges to keep the plan current as work happens, each naming the exact call to make. Agents tend to tick steps in
 * bulk at the end of a phase, so the board shows no live progress. Only for open, non-epic tasks with a plan.
 * `closing` is set by the move to Done, so a long-Done task never nags; `now` is passed in for tests.
 */
export function progressHints(task: TaskDetail, now: number, opts: { closing?: boolean } = {}): string[] {
  // A manual task's plan, if it has one, is the user's checklist: nobody is reporting progress on it.
  if (task.kind === "epic" || task.manual || task.archivedAt || task.resolution || task.progress.total === 0) return [];
  const ref = `"#${task.number}"`;
  const steps = stepLabels(task.phases);
  const open = steps.filter((s) => s.step.status !== "done" && s.step.status !== "skipped");
  const hints: string[] = [];

  if ((task.status === "review" || (task.status === "done" && opts.closing)) && open.length > 0) {
    const shown = open.slice(0, LISTED_STEPS).map((s) => `${s.label} ${s.step.title} [${s.step.status}]`);
    const more = open.length - shown.length;
    hints.push(
      `${open.length} plan step(s) are still open on a task in ${statusLabel(task.status)}: ${shown.join("; ")}` +
        `${more > 0 ? `; and ${more} more` : ""}. Mark each done (or skipped if it no longer applies) with ` +
        `update_plan(task: ${ref}, steps: [{step: "${open[0]!.label}", status: "done"}, ...]), or add a note if it was left undone.`,
    );
  }

  if (task.status === "in_progress") {
    const current = task.currentStep;
    const started = steps.some((s) => s.step.status === "in_progress");
    if (!started && current?.status === "todo") {
      hints.push(
        `No plan step is in progress. Before you start ${current.index} "${current.title}", call ` +
          `update_step(task: ${ref}, step: "${current.index}", status: "in_progress"), and mark it done the moment it is ` +
          "finished, not at the end of the phase.",
      );
    } else if (started && open.length > 0) {
      const last = Math.max(...steps.map((s) => Date.parse(s.step.updatedAt)));
      const minutes = Math.floor((now - last) / 60_000);
      if (Number.isFinite(last) && now - last >= STALE_PLAN_MS && current) {
        hints.push(
          `No plan step has changed for ${minutes} minutes. If ${current.index} "${current.title}" is finished, mark it ` +
            `done with update_step(task: ${ref}, step: "${current.index}", status: "done"); if you are stuck on it, mark ` +
            "it blocked with a note.",
        );
      }
    }
  }
  return hints;
}

/**
 * Feedback for an update_plan call that moved two or more steps straight to done without ever starting them: the
 * catch-up batching that leaves the board with no live progress. `before` is the plan as it was ahead of the call.
 */
export function batchedCompletionHint(
  before: ReadonlyArray<PlanPhase>,
  after: ReadonlyArray<PlanPhase>,
  taskRef: string,
): string | null {
  const wasDone = new Set(
    stepLabels(before).flatMap((s) => (s.step.status === "done" || s.step.status === "skipped" ? [s.step.id] : [])),
  );
  const batched = stepLabels(after).filter(
    (s) => s.step.status === "done" && !wasDone.has(s.step.id) && s.step.startedAt === null,
  );
  if (batched.length < 2) return null;
  const shown = batched.slice(0, LISTED_STEPS).map((s) => `${s.label} ${s.step.title}`);
  const more = batched.length - shown.length;
  return (
    `${batched.length} steps went straight to done without being started (${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}), ` +
    "so the board showed no progress while you worked on them. Update each step the moment it changes: " +
    `update_step(task: ${taskRef}, step, status: "in_progress") when you start it and "done" when it is finished. ` +
    "If steps can only be verified together, still mark each in_progress as you start it and done once it is written, " +
    "with testing as its own step. Keep update_plan for changes that really are several at once."
  );
}

function findingLine(f: ReviewFinding): string {
  const where = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : "";
  const resolution = f.status === "open" ? "" : ` -> ${f.status}${f.resolutionNote ? `: ${f.resolutionNote}` : ""}`;
  return `  ${f.label} [${f.severity}]${where} ${f.title}${resolution}`;
}

const indented = (text: string) => text.trim().replace(/\n/g, "\n      ");

/**
 * The review section: the badge, the latest round's findings in full (with body and suggestion while open),
 * then earlier rounds' findings: open ones, and resolved ones so the next reviewer can check the fixes hold.
 */
function reviewLines(task: TaskDetail): string[] {
  const latest = task.reviews.at(-1);
  if (!task.review || !latest) return [];
  const r = task.review;
  const lines = [
    "",
    `Local review: ${reviewBadgeLabel(r)} (round ${latest.round}, ${r.round} of ${r.maxRounds} this cycle, ${latest.status})`,
  ];
  if (r.verifiedOnPr)
    lines.push("  The fixes were re-reviewed on the pull request: Autopilot's PR review came back clean.");
  else if (reviewFixedAtLimit(r)) {
    lines.push("  The fixes were made in the last allowed round, so no round will re-review them.");
  }
  if (latest.summary) lines.push(`  Summary: ${latest.summary}`);
  if (latest.error) lines.push(`  Error: ${latest.error}`);
  // Open findings carry their detail wherever they are listed: the implementer fixes from it.
  const pushFinding = (f: ReviewFinding, indent = "") => {
    lines.push(`${indent}${findingLine(f)}`);
    if (f.status !== "open") return;
    if (f.body?.trim()) lines.push(`${indent}      ${indented(f.body)}`);
    if (f.suggestion?.trim()) lines.push(`${indent}      Suggestion: ${indented(f.suggestion)}`);
  };
  for (const f of latest.findings) pushFinding(f);
  const previous = task.reviews.slice(0, -1).flatMap((round) => round.findings);
  const earlier = previous.filter((f) => f.status === "open");
  if (earlier.length) {
    lines.push("  Still open from earlier rounds:");
    for (const f of earlier) pushFinding(f, "  ");
  }
  const resolved = previous.filter((f) => f.status !== "open");
  if (resolved.length) {
    lines.push("  Resolved in earlier rounds:");
    for (const f of resolved) lines.push(`  ${findingLine(f)}`);
  }
  const gating = [...earlier, ...latest.findings].filter((f) => f.status === "open" && isGatingSeverity(f.severity));
  if (gating.length) {
    lines.push(`  Resolve each with resolve_finding(task: "#${task.number}", finding: "<label>", status, note).`);
  }
  return lines;
}

/** What an epic's overview knows about a child beyond its summary: its newest activity entry. */
export type ChildActivity = ReadonlyMap<string, TaskEvent>;

/**
 * An epic's children grouped by status, each with its summary line, then its live T3 thread, latest note and
 * newest activity: what an orchestrating agent checks to see how each child is getting on, whichever way it was
 * started.
 */
export function renderEpicChildren(epic: TaskDetail, activity: ChildActivity = new Map()): string {
  const lines = [`Tasks (${epic.rollup ? describeEpicRollup(epic.rollup) : "none"}):`];
  if (epic.children.length === 0) {
    lines.push(
      `  none yet. Create them with create_task or add_to_backlog (epic: "#${epic.number}"), or attach existing ` +
        `tasks with update_task(task, epic: "#${epic.number}").`,
    );
    return lines.join("\n");
  }
  for (const { value, label } of TASK_STATUSES) {
    const inStatus = epic.children.filter((t) => t.status === value);
    if (inStatus.length === 0) continue;
    lines.push(`  ${label} (${inStatus.length}):`);
    for (const child of inStatus) {
      lines.push(`    ${summaryLine(child, { inEpic: false })}${child.archivedAt ? " (archived)" : ""}`);
      const threads = child.links.flatMap((l) => (l.kind === "t3_thread" && l.snapshot ? [l.snapshot] : []));
      const live = threads.find((t) => !t.settled && !t.archived);
      if (live) lines.push(`      thread: ${live.title} (${live.status})`);
      if (child.lastNote) {
        const text = child.lastNote.text.replace(/\s+/g, " ").trim();
        lines.push(
          `      last note (${child.lastNote.actor}, ${child.lastNote.at.slice(0, 16).replace("T", " ")}): ` +
            (text.length > 200 ? `${text.slice(0, 197)}...` : text),
        );
      }
      const last = activity.get(child.id);
      if (last && last.type !== "note") lines.push(`      last activity: ${eventText(last)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Where an integration epic's work goes: for the epic its branch, for its tasks the branch they start from and open
 * their pull requests against. Null for everything delivered to main.
 */
export function deliveryLine(task: Pick<TaskSummary, "kind" | "delivery" | "integrationBranch">): string | null {
  if (!task.integrationBranch) return null;
  return task.kind === "epic"
    ? `Delivery: integration branch ${task.integrationBranch} (Autopilot merges its tasks' pull requests into it; the user merges it into the default branch)`
    : `Delivery: start from ${task.integrationBranch} and open your pull request against it, not the default branch`;
}

/** Full "where was I" rendering of a task. */
export function renderTaskDetail(
  task: TaskDetail,
  project: Project | undefined,
  opts: {
    events?: number;
    labelsInUse?: ReadonlyArray<LabelUsage>;
    modelHint?: boolean;
    /** The harness calling, when it is one that can link its own session; the Missing links hint asks for it. */
    sessionHarness?: AgentHarness | null;
    /** Whether Start planned tasks is on for the task's scope, which makes the Autopilot flag worth asking about. */
    autopilotHint?: boolean;
    /** The epic delivery question (deliveryHint), when the caller found it applies. */
    deliveryHint?: string | null;
    /** Adds the "Plan progress" nudges; off for renderings that aren't for the implementing agent. */
    progress?: { now: number; closing?: boolean };
    /** For an epic: each child's newest activity, shown in its overview. */
    childActivity?: ChildActivity;
    /** Images pasted into the task's text, with where they are on disk. */
    images?: ReadonlyArray<{ path: string; filename: string; size: number }>;
    /** The configured ticket systems, which name ticket links and find the keys a task hasn't linked. */
    ticketSystems?: readonly TicketSystem[];
  } = {},
): string {
  const lines: string[] = [];
  const epic = task.kind === "epic";
  const status = epic ? `Epic · ${statusLabel(task.status)}` : statusLabel(task.status);
  lines.push(`#${task.number} ${task.title} [${status}]${task.archivedAt ? " (archived)" : ""}`);
  lines.push(`Project: ${projectLabel(project)}  ·  task id: ${task.id}`);
  if (task.parent) lines.push(`Epic: #${task.parent.number} ${task.parent.title}`);
  const delivery = deliveryLine(task);
  if (delivery) lines.push(delivery);
  if (task.labels.length) lines.push(`Labels: ${task.labels.join(", ")}`);
  if (task.suggestedModel) {
    const { tier, reason } = task.suggestedModel;
    lines.push(`Suggested model: ${tier}${reason ? ` (${reason})` : ""}`);
  }
  if (task.autopilot !== null) lines.push(`Autopilot: flagged ${task.autopilot ? "on" : "off"}`);
  if (task.autoMerge !== null) {
    lines.push(`Auto-merge: ${task.autoMerge ? "on (merge_task_pr may merge its PR)" : "off"}`);
  }
  if (task.priority) lines.push("Priority: yes (shown in the priority lane)");
  if (task.manual) {
    lines.push("Manual task: yes (a to-do for a person; agents and Autopilot leave it alone, so don't work on it)");
  }
  if (task.dueDate) lines.push(`Due: ${task.dueDate}`);
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
  if (task.blockedBy.length) {
    const wait = task.blocked
      ? ` (blocked until ${openBlockers(task)
          .map((b) => `#${b.number}`)
          .join(", ")} are Done)`
      : "";
    lines.push(`Blocked by: ${task.blockedBy.map(relationText).join("; ")}${wait}`);
  }
  if (task.blocks.length) lines.push(`Blocks: ${task.blocks.map(relationText).join("; ")}`);
  if (task.attention.length) lines.push(`Needs attention: ${task.attention.map((a) => a.message).join("; ")}`);
  if (task.import?.status === "pending") {
    lines.push(`Import: pending. The title, description and labels are being filled in from ${task.import.sourceUrl}.`);
  }

  if (task.description?.trim()) lines.push("", "Description:", task.description.trim());
  if (task.planContext?.trim()) lines.push("", "Plan context:", task.planContext.trim());
  if (opts.images?.length) {
    lines.push("", "Images (pasted into the text as ![..](attachment:id); open them as files):");
    for (const image of opts.images) lines.push(`- ${image.path} (${image.filename}, ${formatBytes(image.size)})`);
  }

  lines.push("");
  if (epic) {
    lines.push(
      "An epic has no plan of its own and its status follows its tasks (the furthest-back open one sets it; Done " +
        "once they all are). Plan, move and review the tasks instead.",
      "",
      renderEpicChildren(task, opts.childActivity),
    );
  } else if (task.phases.some((p) => p.steps.length > 0)) {
    lines.push("Plan:", formatPlanText(task.phases, task.currentStep));
    const withNotes = task.phases.flatMap((phase, pi) =>
      phase.steps.flatMap((step, si) => (step.notes?.trim() ? [`  ${pi + 1}.${si + 1}: ${step.notes.trim()}`] : [])),
    );
    if (withNotes.length) lines.push("Step notes:", ...withNotes);
  } else if (task.resolution || task.manual) {
    lines.push("Plan: none.");
  } else {
    lines.push("Plan: none yet. Add one with set_plan before moving this out of Backlog.");
  }

  lines.push(...reviewLines(task));

  if (task.links.length) {
    lines.push("", "Links:");
    for (const link of task.links) lines.push(`- ${linkText(link, opts.ticketSystems)}`);
  }
  const missing = missingLinkHints(task, opts.sessionHarness ?? null, opts.ticketSystems);
  if (missing.length) {
    lines.push("", "Missing links:");
    for (const hint of missing) lines.push(`- ${hint}`);
  }
  const progress = opts.progress
    ? progressHints(task, opts.progress.now, { closing: opts.progress.closing ?? false })
    : [];
  if (progress.length) {
    lines.push("", "Plan progress:");
    for (const hint of progress) lines.push(`- ${hint}`);
  }
  const labels = opts.labelsInUse ? labelHint(task, opts.labelsInUse) : null;
  if (labels) lines.push("", "Missing labels:", `- ${labels}`);
  const model = opts.modelHint ? suggestedModelHint(task) : null;
  if (model) lines.push("", "Missing suggested model:", `- ${model}`);
  const autopilot = opts.autopilotHint ? autopilotFlagHint(task) : null;
  if (autopilot) lines.push("", "Autopilot flag not set:", `- ${autopilot}`);
  if (opts.deliveryHint) lines.push("", "Epic delivery not chosen:", `- ${opts.deliveryHint}`);

  const limit = opts.events ?? 10;
  if (limit > 0 && task.events.length) {
    const recent = [...task.events].sort((a, b) => b.id - a.id).slice(0, limit);
    lines.push("", `Recent activity (newest first, ${recent.length} of ${task.events.length}):`);
    for (const e of recent) lines.push(`- ${eventText(e)}`);
  }
  return lines.join("\n");
}

/** Short post-mutation rendering: header, current step and the plan. */
export function renderTaskShort(
  task: TaskDetail,
  project: Project | undefined,
  opts: {
    labelsInUse?: ReadonlyArray<LabelUsage>;
    modelHint?: boolean;
    autopilotHint?: boolean;
    deliveryHint?: string | null;
    progress?: { now: number; closing?: boolean };
    ticketSystems?: readonly TicketSystem[];
  } = {},
): string {
  return renderTaskDetail(task, project, { ...opts, events: 0 });
}

const spanText = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/** A condensed session transcript: a header with the totals, then one page of entries and where the next one starts. */
export function renderTranscript(t: SessionTranscript): string {
  const { stats, page } = t;
  const counts = [
    `${stats.turns} turn${stats.turns === 1 ? "" : "s"}`,
    `${stats.toolCalls} tool call${stats.toolCalls === 1 ? "" : "s"}`,
    `${stats.errors} error${stats.errors === 1 ? "" : "s"}`,
    `${stats.denials} denied`,
    `${stats.retries} retr${stats.retries === 1 ? "y" : "ies"}`,
    `${stats.interruptions} interruption${stats.interruptions === 1 ? "" : "s"}`,
    ...(stats.durationMs !== null ? [spanText(stats.durationMs)] : []),
  ];
  const lines = [
    // The label is free text an agent wrote, so it is redacted like the transcript.
    `Transcript of Claude Code session ${t.sessionId}${t.label ? ` "${redact(t.label)}"` : ""} for #${t.taskNumber}`,
    // The others are described (and redacted) by the reader.
    ...(t.otherSessions?.length
      ? [
          `The newest of ${t.otherSessions.length + 1} linked Claude Code sessions; pass session to read another: ${t.otherSessions.join("; ")}.`,
        ]
      : []),
    counts.join(", "),
  ];
  if (stats.startedAt) lines.push(`From ${stats.startedAt}${stats.endedAt ? ` to ${stats.endedAt}` : ""}`);
  if (page.total === 0) return [...lines, "", "The transcript has no messages."].join("\n");
  if (page.lines.length === 0) {
    const entries = `${page.total} entr${page.total === 1 ? "y" : "ies"}`;
    lines.push(
      "",
      `Offset ${page.offset} is past the end: the transcript has ${entries}, offsets 0 to ${page.total - 1}.`,
    );
    return lines.join("\n");
  }
  const to = page.offset + page.lines.length;
  lines.push(`Entries ${page.offset + 1}-${to} of ${page.total} (offset ${page.offset}):`, "", ...page.lines);
  lines.push("", page.next === null ? "End of transcript." : `More follows: call again with offset: ${page.next}.`);
  return lines.join("\n");
}
