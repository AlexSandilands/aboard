import {
  AGENT_HARNESSES,
  type AgentHarness,
  TASK_STATUSES,
  describeEpicRollup,
  findJiraKeys,
  formatPlanText,
  isGatingSeverity,
  type LabelUsage,
  reviewBadgeLabel,
  reviewIsDone,
  type ReviewFinding,
  type Project,
  type TaskDetail,
  type TaskEvent,
  type TaskLink,
  type TaskStatus,
  type TaskSummary,
} from "@repo/contracts";

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
    case "jira":
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
  } else if (task.status === "backlog") {
    parts.push("no plan");
  }
  if (task.parent && opts.inEpic !== false) parts.push(`in epic #${task.parent.number}`);
  const links = task.links.map(shortLink);
  if (links.length) parts.push(links.join(", "));
  if (task.review) parts.push(`review: ${reviewBadgeLabel(task.review)}`);
  if (task.attention.length) parts.push(`! ${task.attention.map((a) => a.message).join("; ")}`);
  const labels = task.labels.length ? ` ${task.labels.map((l) => `[${l}]`).join(" ")}` : "";
  const epic = task.kind === "epic" ? " [epic]" : "";
  return `#${task.number} ${task.title}${epic}${labels}${parts.length ? ` — ${parts.join(" · ")}` : ""}`;
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
    case "suggested_model_changed":
      what = str("tier")
        ? `suggested model ${str("tier")}${str("reason") ? ` (${str("reason")})` : ""}`
        : "suggested model cleared";
      break;
    case "created":
      what = `created ${p.kind === "epic" ? "the epic" : `in ${statusLabel((str("status") ?? "backlog") as TaskStatus)}`}`;
      if (typeof p.epic === "number") what += ` in epic #${p.epic}`;
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
    default: {
      const json = Object.keys(p).length ? ` ${JSON.stringify(p)}` : "";
      what = `${event.type.replace(/_/g, " ")}${json.length > 160 ? `${json.slice(0, 157)}...` : json}`;
    }
  }
  return `${event.at.slice(0, 16).replace("T", " ")} ${event.actor}: ${what}`;
}

/**
 * Links an open task is missing, each naming the exact call that adds it: Jira keys mentioned in the title or
 * description, the agent's own T3 thread, and the PR once the review loop has ended. Agents act on what tool results say far more reliably than on
 * instructions read once, and `link` is idempotent, so following a hint twice is harmless.
 */
export function missingLinkHints(task: TaskDetail, sessionHarness: AgentHarness | null = null): string[] {
  if (task.status === "done" || task.archivedAt) return [];
  const ref = `"#${task.number}"`;
  const linked = new Set(task.links.flatMap((l) => (l.kind === "jira" ? [l.ref.key] : [])));
  const keys = new Set([...findJiraKeys(task.title), ...findJiraKeys(task.description)]);
  const hints = [...keys]
    .filter((key) => !linked.has(key))
    .map((key) => `Jira ${key}: link(task: ${ref}, value: "${key}")`);
  if (!task.links.some((l) => l.kind === "t3_thread")) {
    hints.push(
      `T3 thread: if you are running in T3 Code, link(task: ${ref}, t3Thread: {environmentId, threadId}) with ids ` +
        "from t3_environment_read and t3_thread_configuration",
    );
  }
  if (sessionHarness && !task.links.some((l) => l.kind === "agent_session" && l.ref.harness === sessionHarness)) {
    const { idEnvVar } = AGENT_HARNESSES[sessionHarness];
    hints.push(
      `Your session: link(task: ${ref}, agentSession: {harness: "${sessionHarness}", sessionId: <$${idEnvVar}>, ` +
        "cwd: <your working directory>}), so the user can see it running and reopen it in a terminal from the board",
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
  if (task.suggestedModel || task.progress.total === 0 || task.resolution || task.status === "done") return null;
  return (
    "This task has no suggested model. Judge how much reasoning implementing it needs and call " +
    `update_task(task: "#${task.number}", suggestedModel: {tier: "light" | "standard" | "deep", reason}).`
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
    /** For an epic: each child's newest activity, shown in its overview. */
    childActivity?: ChildActivity;
  } = {},
): string {
  const lines: string[] = [];
  const epic = task.kind === "epic";
  const status = epic ? `Epic · ${statusLabel(task.status)}` : statusLabel(task.status);
  lines.push(`#${task.number} ${task.title} [${status}]${task.archivedAt ? " (archived)" : ""}`);
  lines.push(`Project: ${projectLabel(project)}  ·  task id: ${task.id}`);
  if (task.parent) lines.push(`Epic: #${task.parent.number} ${task.parent.title}`);
  if (task.labels.length) lines.push(`Labels: ${task.labels.join(", ")}`);
  if (task.suggestedModel) {
    const { tier, reason } = task.suggestedModel;
    lines.push(`Suggested model: ${tier}${reason ? ` (${reason})` : ""}`);
  }
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
  if (task.import?.status === "pending") {
    lines.push(`Import: pending. The title, description and labels are being filled in from ${task.import.sourceUrl}.`);
  }

  if (task.description?.trim()) lines.push("", "Description:", task.description.trim());
  if (task.planContext?.trim()) lines.push("", "Plan context:", task.planContext.trim());

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
  } else if (task.resolution) {
    lines.push("Plan: none.");
  } else {
    lines.push("Plan: none yet. Add one with set_plan before moving this out of Backlog.");
  }

  lines.push(...reviewLines(task));

  if (task.links.length) {
    lines.push("", "Links:");
    for (const link of task.links) lines.push(`- ${linkText(link)}`);
  }
  const missing = missingLinkHints(task, opts.sessionHarness ?? null);
  if (missing.length) {
    lines.push("", "Missing links:");
    for (const hint of missing) lines.push(`- ${hint}`);
  }
  const labels = opts.labelsInUse ? labelHint(task, opts.labelsInUse) : null;
  if (labels) lines.push("", "Missing labels:", `- ${labels}`);
  const model = opts.modelHint ? suggestedModelHint(task) : null;
  if (model) lines.push("", "Missing suggested model:", `- ${model}`);

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
  opts: { labelsInUse?: ReadonlyArray<LabelUsage>; modelHint?: boolean } = {},
): string {
  return renderTaskDetail(task, project, { ...opts, events: 0 });
}
