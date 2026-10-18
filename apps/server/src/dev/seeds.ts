import {
  BOARD_REVIEWER,
  type AgentHarness,
  type AgentSessionSnapshot,
  type PlanInput,
  type PrSnapshot,
  type T3ThreadSnapshot,
  type TaskStatus,
} from "@repo/contracts";
import { createContext } from "../context.ts";
import type { Db } from "../db/database.ts";
import type { Services } from "../services/types.ts";

/**
 * Example boards for `pnpm sandbox`. Seeds go through the services, like the REST and MCP layers do, so they
 * stay valid as the schema changes. Poller-owned state (PR checks, T3 thread status) goes through
 * `links.setSnapshot`, the same call the pollers make.
 */

const AGENT = "claude-code";

export interface SeedOptions {
  /** Workspace of the first project, so project-scoped features (skills, T3 launch) have a real folder. */
  workspaceRoot?: string;
}

type Scenario = (s: Services, opts: SeedOptions) => void;

interface TaskSpec {
  title: string;
  status: TaskStatus;
  description?: string;
  plan?: PlanInput;
  links?: string[];
  labels?: string[];
  epicId?: string;
}

/** Creates a task and moves it to its column. Tasks past Backlog get a one-phase plan when none is given. */
function addTask(s: Services, projectId: string, spec: TaskSpec): string {
  const plan =
    spec.plan ??
    (spec.status === "backlog" ? undefined : steps("Do it", ["Implement", "Test"], spec.status === "done"));
  const task = s.tasks.create({
    projectId,
    title: spec.title,
    description: spec.description,
    plan,
    links: spec.links?.map((value) => ({ value })),
    labels: spec.labels,
    epicId: spec.epicId,
    actor: AGENT,
  });
  if (spec.status !== task.status) s.tasks.move(task.id, { status: spec.status }, AGENT);
  return task.id;
}

function steps(phase: string, titles: string[], done = false): PlanInput {
  return { phases: [{ title: phase, steps: titles.map((title) => ({ title, status: done ? "done" : "todo" })) }] };
}

const basic: Scenario = (s, opts) => {
  const shop = s.projects.create({
    title: "Web shop",
    workspaceRoot: opts.workspaceRoot,
    icon: { kind: "lucide", name: "shopping-cart", color: "blue" },
  });
  const billing = s.projects.create({ title: "Billing API" });

  addTask(s, shop.id, {
    title: "Dark mode for checkout",
    status: "backlog",
    description: "Customers asked for it in the last survey.",
  });
  const planned = addTask(s, shop.id, { title: "Retry flaky payment webhooks", status: "backlog" });
  s.plans.setPlan(
    planned,
    { context: "Backlog task with a plan already written.", ...steps("Retry", ["Add backoff", "Log final failures"]) },
    AGENT,
  );
  const edgeCache = addTask(s, shop.id, { title: "Cache product images at the edge", status: "planned" });
  const estimates = addTask(s, shop.id, {
    title: "Show delivery estimates on the product page",
    status: "planned",
    description: "Use the carrier API; fall back to the static table.",
    links: ["SHOP-412"],
  });

  const active = addTask(s, shop.id, {
    title: "Rewrite the cart drawer",
    status: "in_progress",
    description: "The drawer re-renders the whole page on every quantity change.",
    plan: {
      context: "**Approach:** move cart state into a store and render the drawer from it.",
      phases: [
        {
          title: "Store",
          steps: [
            { title: "Add cart store", status: "done" },
            { title: "Move quantity updates into the store", status: "done" },
          ],
        },
        {
          title: "Drawer",
          steps: [
            { title: "Render drawer from the store", status: "in_progress", notes: "Half the line items done." },
            {
              title: "Wire promo codes",
              status: "blocked",
              notes: "Waiting on the promo API contract from the billing team.",
            },
            { title: "Remove the old drawer", status: "todo" },
            { title: "Animate open/close", status: "skipped", notes: "Not needed after design review." },
          ],
        },
      ],
    },
  });
  s.tasks.addNote(active, "Handover: store done, drawer half done. Next: finish line items, then promo codes.", AGENT);
  addTask(s, shop.id, { title: "Fix currency rounding in the order summary", status: "review" });

  const doneTitles = [
    "Add a sitemap",
    "Lazy-load reviews",
    "Upgrade the router",
    "Fix broken footer links",
    "Add an order history page",
    "Compress hero images",
  ];
  const doneIds = doneTitles.map((title) => addTask(s, shop.id, { title, status: "done" }));
  const dup = addTask(s, shop.id, { title: "Sitemap for SEO", status: "backlog" });
  s.tasks.close(dup, { resolution: "duplicate", byTaskId: doneIds[0]! }, AGENT);
  const dropped = addTask(s, shop.id, { title: "Support Internet Explorer", status: "backlog" });
  s.tasks.close(dropped, { resolution: "wont_do" }, "user");
  const archived = addTask(s, shop.id, { title: "Old launch checklist", status: "done" });
  s.tasks.update(archived, { archived: true }, "user");

  // An epic whose children span Backlog to Review, so its band covers four columns.
  const checkout = s.tasks.create({
    projectId: shop.id,
    title: "One-page checkout",
    kind: "epic",
    description: "Replace the three-step checkout with a single page.",
    actor: AGENT,
  }).id;
  addTask(s, shop.id, { title: "Address autocomplete", status: "backlog", epicId: checkout });
  const payment = addTask(s, shop.id, { title: "Inline payment form", status: "in_progress", epicId: checkout });
  addTask(s, shop.id, { title: "Merge shipping and billing steps", status: "review", epicId: checkout });
  s.tasks.create({ projectId: billing.id, title: "Usage-based pricing", kind: "epic", actor: AGENT });
  // Finished epics, which show as cards among the Done cards instead of bands.
  for (const [title, tasks] of [
    ["Faster product pages", ["Preload hero images", "Split the product bundle", "Cache price lookups"]],
    ["Guest checkout", ["Skip account creation", "Email receipts to guests"]],
  ] as const) {
    const done = s.tasks.create({ projectId: shop.id, title, kind: "epic", actor: AGENT }).id;
    for (const child of tasks) addTask(s, shop.id, { title: child, status: "done", epicId: done });
  }

  const invoices = addTask(s, billing.id, { title: "Invoice PDFs in the customer's language", status: "backlog" });
  addTask(s, billing.id, { title: "Rate-limit the refunds endpoint", status: "in_progress" });
  addTask(s, billing.id, { title: "Nightly reconciliation report", status: "done" });

  // A dependency chain across both projects: edge cache > delivery estimates > invoice PDFs, with the cart
  // rewrite holding up the webhook retries and a finished blocker (the router upgrade) behind the payment form.
  s.tasks.update(estimates, { addBlockedBy: [edgeCache] }, AGENT);
  s.tasks.update(invoices, { addBlockedBy: [estimates] }, AGENT);
  s.tasks.update(planned, { addBlockedBy: [active] }, AGENT);
  s.tasks.update(payment, { addBlockedBy: [doneIds[2]!, active] }, AGENT);
};

const review: Scenario = (s, opts) => {
  const project = s.projects.create({ title: "Review states", workspaceRoot: opts.workspaceRoot });
  const inReview = (title: string) => addTask(s, project.id, { title, status: "review" });
  const open = (taskId: string) => s.reviews.openRound(taskId, { trigger: "manual", actor: AGENT, force: true });

  open(inReview("Round pending, no reviewer yet"));

  const running = open(inReview("Board reviewer running"));
  s.reviews.setRoundStatus(running.id, "running", { actor: BOARD_REVIEWER });

  const stalled = open(inReview("Round stalled"));
  s.reviews.setRoundStatus(stalled.id, "stalled", {
    actor: BOARD_REVIEWER,
    error: "No reviewer picked the round up and headless review is off.",
  });

  const failed = open(inReview("Round failed"));
  s.reviews.setRoundStatus(failed.id, "failed", { actor: BOARD_REVIEWER, error: "Reviewer CLI exited with code 1." });

  const severities = inReview("Findings at every severity");
  open(severities);
  s.reviews.submit(
    severities,
    {
      summary: "Works, but the migration can lose data and the new endpoint is untested.",
      headSha: "3f2a9c1",
      findings: [
        {
          severity: "blocking",
          title: "Migration drops rows with a null owner",
          file: "apps/server/src/db/migrations/005_owner.sql",
          line: 12,
          body: "The `INSERT ... SELECT` skips rows where `owner_id` is null.",
          suggestion: "Backfill a default owner before copying.",
        },
        { severity: "major", title: "New endpoint has no tests", file: "apps/server/src/http/routes.ts" },
        { severity: "major", title: "Error message leaks the SQL", file: "apps/server/src/errors.ts", line: 40 },
        { severity: "minor", title: "Duplicate date formatting helper", file: "apps/web/src/lib/date.ts" },
        { severity: "nit", title: "Typo in the toast text" },
      ],
    },
    AGENT,
  );
  s.reviews.resolveFinding(severities, "R1.3", { status: "fixed", note: "Now returns a generic message." }, AGENT);
  s.reviews.resolveFinding(severities, "R1.4", { status: "wont_fix", note: "Out of scope; follow-up idea." }, AGENT);

  const clean = inReview("Clean after a second round");
  open(clean);
  s.reviews.submit(clean, { findings: [{ severity: "major", title: "Missing null check" }] }, AGENT);
  s.reviews.resolveFinding(clean, "R1.1", { status: "fixed" }, AGENT);
  open(clean);
  s.reviews.submit(clean, { summary: "All good.", findings: [] }, AGENT);

  const rereview = inReview("Fixes in, re-review pending");
  open(rereview);
  s.reviews.submit(rereview, { findings: [{ severity: "blocking", title: "Race on concurrent saves" }] }, AGENT);
  s.reviews.resolveFinding(rereview, "R1.1", { status: "fixed" }, AGENT);
  open(rereview);
};

const threads: Scenario = (s, opts) => {
  const project = s.projects.create({ title: "Links and threads", workspaceRoot: opts.workspaceRoot });
  const now = new Date().toISOString();
  let prNumber = 100;
  let threadNumber = 0;

  /** What the poller reads about a repo the signed-in account can push to. */
  const mergeable = {
    mergeMethods: ["merge", "squash"],
    autoMergeAllowed: true,
    canMerge: true,
    autoMerge: null,
  } satisfies Partial<PrSnapshot>;
  const pr = (
    status: TaskStatus,
    title: string,
    snapshot: Omit<PrSnapshot, "title" | "headRef" | "updatedAt"> | null,
    host = "github.com",
  ) => {
    prNumber += 1;
    const id = addTask(s, project.id, { title, status, links: [`https://${host}/example/shop/pull/${prNumber}`] });
    const link = s.tasks.detail(id).links[0]!;
    if (snapshot)
      s.links.setSnapshot(link.id, {
        ...snapshot,
        title,
        headRef: `feature/pr-${prNumber}`,
        headOid: `head-${prNumber}`,
        updatedAt: now,
      });
  };
  pr("review", "PR open, checks passing, approved", {
    state: "open",
    checks: "passing",
    reviewDecision: "approved",
    mergeable: "mergeable",
    ...mergeable,
  });
  pr("review", "PR checks running, ready for auto-merge", {
    state: "open",
    checks: "pending",
    reviewDecision: "approved",
    mergeable: "mergeable",
    ...mergeable,
  });
  pr("review", "PR with auto-merge on", {
    state: "open",
    checks: "pending",
    reviewDecision: "approved",
    mergeable: "mergeable",
    ...mergeable,
    autoMerge: "squash",
  });
  pr(
    "review",
    "PR on a GitHub Enterprise host",
    { state: "open", checks: "passing", reviewDecision: null, mergeable: "mergeable", ...mergeable },
    "github.example.com",
  );
  pr("review", "PR the signed-in account can't merge", {
    state: "open",
    checks: "passing",
    reviewDecision: "approved",
    mergeable: "mergeable",
    ...mergeable,
    canMerge: false,
  });
  pr("in_progress", "PR draft, checks pending", {
    state: "draft",
    checks: "pending",
    reviewDecision: null,
    mergeable: "unknown",
  });
  pr("review", "PR checks failing, changes requested", {
    state: "open",
    checks: "failing",
    reviewDecision: "changes_requested",
    mergeable: "mergeable",
  });
  pr("review", "PR conflicting with main", {
    state: "open",
    checks: "passing",
    reviewDecision: "review_required",
    mergeable: "conflicting",
  });
  pr("done", "PR merged", { state: "merged", checks: "passing", reviewDecision: "approved", mergeable: "unknown" });
  pr("in_progress", "PR closed without merging", {
    state: "closed",
    checks: "none",
    reviewDecision: null,
    mergeable: "unknown",
  });
  pr("review", "PR not polled yet", null);

  const thread = (status: TaskStatus, title: string, snapshot: Omit<T3ThreadSnapshot, "title">) => {
    threadNumber += 1;
    const id = addTask(s, project.id, {
      title,
      status,
      links: [`t3code://threads/sandbox-env/thread-${threadNumber}`],
    });
    const link = s.tasks.detail(id).links[0]!;
    s.links.setSnapshot(link.id, { ...snapshot, title, lastActivityAt: now, model: "claude-opus", branch: null });
  };
  thread("in_progress", "Thread working", { status: "working" });
  thread("in_progress", "Thread waiting", { status: "waiting" });
  thread("in_progress", "Thread needs input", { status: "input" });
  thread("in_progress", "Thread needs approval", { status: "approval" });
  thread("in_progress", "Thread failed", { status: "failed" });
  thread("review", "Thread done", { status: "done" });
  thread("planned", "Thread idle", { status: "idle" });
  thread("done", "Thread settled", { status: "done", settled: true });
  thread("done", "Thread archived", { status: "idle", archived: true });

  // Cards show only active threads; the panel lists all three, settled and archived dimmed.
  const mixed = addTask(s, project.id, {
    title: "Threads active, settled and archived",
    status: "in_progress",
    links: ["active", "settled", "archived"].map((name) => `t3code://threads/sandbox-env/thread-mixed-${name}`),
  });
  const [active, settled, archivedThread] = s.tasks.detail(mixed).links;
  const mixedSnapshot = { lastActivityAt: now, model: "claude-opus", branch: null };
  s.links.setSnapshot(active!.id, { ...mixedSnapshot, title: "Active thread", status: "working" });
  s.links.setSnapshot(settled!.id, { ...mixedSnapshot, title: "Settled thread", status: "done", settled: true });
  s.links.setSnapshot(archivedThread!.id, {
    ...mixedSnapshot,
    title: "Archived thread",
    status: "idle",
    archived: true,
  });

  addTask(s, project.id, {
    title: "Jira and plain links",
    status: "planned",
    links: ["SHOP-77", "https://example.com/design-spec"],
  });

  // Agent sessions in each status. The ids are made up, so the pollers would find none of them running; the
  // pollers are off in a sandbox, and opening one reads its real status first.
  const sessionCwd = opts.workspaceRoot ?? "/work/links";
  const session = (title: string, harness: AgentHarness, snapshot: AgentSessionSnapshot | null, n: number) => {
    const taskId = addTask(s, project.id, { title, status: "in_progress" });
    const sessionId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const link = s.links.add(taskId, { agentSession: { harness, sessionId, cwd: sessionCwd } }, AGENT);
    if (snapshot) s.links.setSnapshot(link.id, snapshot);
  };
  session("Claude session working", "claude-code", { status: "busy", inApp: false }, 1);
  session("Claude session idle", "claude-code", { status: "idle", inApp: false }, 2);
  session("Claude session not running", "claude-code", { status: "not_running", inApp: false }, 3);
  const ended = new Date(Date.now() - 12 * 60_000).toISOString();
  session("Autopilot session finished", "claude-code", { status: "finished", inApp: false, endedAt: ended }, 7);
  session("Autopilot session failed", "claude-code", { status: "failed", inApp: false, endedAt: ended }, 8);
  session("Copilot session running", "copilot-cli", { status: "running", inApp: false }, 4);
  session("Session status unknown", "claude-code", null, 5);
  // A thread hides the session on the card; the panel shows both.
  const inT3 = addTask(s, project.id, {
    title: "Session inside a T3 thread",
    status: "in_progress",
    links: ["t3code://threads/sandbox-env/thread-with-session"],
  });
  s.links.setSnapshot(s.tasks.detail(inT3).links[0]!.id, {
    title: "Thread with a session",
    status: "working",
    lastActivityAt: now,
    model: "claude-opus",
    branch: null,
  });
  const inT3Session = s.links.add(
    inT3,
    {
      agentSession: { harness: "claude-code", sessionId: "00000000-0000-4000-8000-000000000006", cwd: sessionCwd },
    },
    AGENT,
  );
  s.links.setSnapshot(inT3Session.id, { status: "busy", inApp: true });

  // Tasks with many sessions, for the panel's Sessions and Links groups: without a T3 thread every session is a
  // row; beside one, its Claude Code sessions fold into the thread's menu and Autopilot's stay rows.
  let manyN = 100;
  const manySession = (taskId: string, label: string | null, snapshot: AgentSessionSnapshot) => {
    const sessionId = `00000000-0000-4000-8000-${String(manyN++).padStart(12, "0")}`;
    const link = s.links.add(
      taskId,
      { agentSession: { harness: "claude-code", sessionId, cwd: sessionCwd }, ...(label ? { label } : {}) },
      AGENT,
    );
    s.links.setSnapshot(link.id, snapshot);
  };
  const manyLinks = [
    "SHOP-31",
    "https://example.com/spec",
    "https://github.com/acme/shop/issues/9",
    "https://github.com/acme/shop/pull/31",
  ];
  const manyEnded = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const noThread = addTask(s, project.id, {
    title: "Many sessions, no T3 thread",
    status: "in_progress",
    links: manyLinks,
  });
  manySession(noThread, "Implementing the cart", { status: "busy", inApp: false });
  manySession(noThread, "Autopilot · Review", { status: "finished", inApp: false, endedAt: manyEnded });
  manySession(noThread, "Autopilot · Fix failing checks", { status: "failed", inApp: false, endedAt: manyEnded });
  manySession(noThread, "Autopilot · Review", { status: "finished", inApp: false, endedAt: manyEnded });
  manySession(noThread, null, { status: "not_running", inApp: false });
  const withThread = addTask(s, project.id, {
    title: "Many sessions beside a T3 thread",
    status: "in_progress",
    links: ["t3code://threads/sandbox-env/thread-many-sessions", ...manyLinks],
  });
  s.links.setSnapshot(s.tasks.detail(withThread).links.find((l) => l.kind === "t3_thread")!.id, {
    title: "Build the cart",
    status: "working",
    lastActivityAt: now,
    model: "claude-opus",
    branch: "feat/cart",
  });
  manySession(withThread, "Planning the cart", { status: "not_running", inApp: false });
  manySession(withThread, "Implementing the cart", { status: "busy", inApp: true });
  manySession(withThread, "Autopilot · Review", { status: "finished", inApp: false, endedAt: manyEnded });
  manySession(withThread, "Autopilot · Fix failing checks", { status: "failed", inApp: false, endedAt: manyEnded });
};

/**
 * A busy, realistic board for screenshots and the README demo: several projects with icons, labels, PRs and T3
 * threads in mixed states, review findings, a blocked step and a handover, all on one screen.
 */
const showcase: Scenario = (s, opts) => {
  const now = new Date().toISOString();
  const shop = s.projects.create({
    title: "storefront",
    workspaceRoot: opts.workspaceRoot,
    icon: { kind: "lucide", name: "shopping-bag", color: "violet" },
  });
  const payments = s.projects.create({
    title: "payments-api",
    icon: { kind: "lucide", name: "credit-card", color: "emerald" },
  });
  const mobile = s.projects.create({ title: "mobile-app", icon: { kind: "lucide", name: "smartphone", color: "sky" } });
  const docs = s.projects.create({ title: "docs-site", icon: { kind: "lucide", name: "book-open", color: "amber" } });

  s.labels.setColor("bug", 0);
  s.labels.setColor("ui", 265);
  s.labels.setColor("backend", 200);
  s.labels.setColor("perf", 35);

  const pr = (taskId: string, number: number, snapshot: Omit<PrSnapshot, "title" | "headRef" | "updatedAt">) => {
    const link = s.links.add(taskId, { value: `https://github.com/example/shop/pull/${number}` }, AGENT);
    const title = s.tasks.summary(taskId).title;
    s.links.setSnapshot(link.id, { ...snapshot, title, headRef: `feat/pr-${number}`, updatedAt: now });
  };
  let threadNumber = 0;
  const thread = (taskId: string, status: T3ThreadSnapshot["status"]) => {
    threadNumber += 1;
    const link = s.links.add(taskId, { value: `t3code://threads/sandbox-env/showcase-${threadNumber}` }, AGENT);
    const title = s.tasks.summary(taskId).title;
    s.links.setSnapshot(link.id, { status, title, lastActivityAt: now, model: "claude-opus", branch: null });
  };
  const done = (title: string, labels?: string[]) => addTask(s, shop.id, { title, status: "done", labels });

  // storefront: the busiest lane.
  addTask(s, shop.id, {
    title: "Wishlist that syncs across devices",
    status: "backlog",
    labels: ["ui", "backend"],
    description: "Came up while building the cart drawer.",
  });
  addTask(s, shop.id, {
    title: "Show delivery estimates on the product page",
    status: "planned",
    labels: ["ui"],
    links: ["SHOP-412"],
    plan: steps("Estimates", ["Call the carrier API", "Fall back to the static table", "Render under the price"]),
  });

  const drawer = addTask(s, shop.id, {
    title: "Rewrite the cart drawer",
    status: "in_progress",
    labels: ["ui", "perf"],
    links: ["SHOP-398"],
    description: "The drawer re-renders the whole page on every quantity change.",
    plan: {
      context: "**Approach:** move cart state into a store and render the drawer from it.",
      phases: [
        {
          title: "Store",
          steps: [
            { title: "Add a cart store", status: "done" },
            { title: "Move quantity updates into the store", status: "done" },
          ],
        },
        {
          title: "Drawer",
          steps: [
            { title: "Render line items from the store", status: "done" },
            { title: "Optimistic quantity changes", status: "in_progress", notes: "Rollback on error still to do." },
            { title: "Wire promo codes", status: "todo" },
            { title: "Remove the old drawer", status: "todo" },
          ],
        },
        {
          title: "Ship",
          steps: [
            { title: "Measure re-renders before and after", status: "todo" },
            { title: "Open the PR", status: "todo" },
          ],
        },
      ],
    },
  });
  s.tasks.addNote(
    drawer,
    "## Handover\nStore done, line items render from it. Next: rollback for optimistic quantity changes, then promo codes.",
    AGENT,
  );
  thread(drawer, "working");

  const rounding = addTask(s, shop.id, {
    title: "Fix currency rounding in the order summary",
    status: "review",
    labels: ["bug"],
    plan: steps("Fix", ["Reproduce with JPY and BHD", "Round in minor units", "Add regression tests"], true),
  });
  pr(rounding, 214, { state: "open", checks: "passing", reviewDecision: "approved", mergeable: "mergeable" });
  s.reviews.openRound(rounding, { trigger: "manual", actor: AGENT, force: true });
  s.reviews.submit(
    rounding,
    { findings: [{ severity: "major", title: "Totals still use floats in the email" }] },
    AGENT,
  );
  s.reviews.resolveFinding(rounding, "R1.1", { status: "fixed", note: "Shared formatter now." }, AGENT);
  s.reviews.openRound(rounding, { trigger: "manual", actor: AGENT, force: true });
  s.reviews.submit(rounding, { summary: "Rounding is correct for every currency now.", findings: [] }, AGENT);

  // Autopilot history. A run still going can't be seeded: the server fails runs a restart left running.
  const autopilotRun = (
    taskId: string,
    automation: string,
    key: string,
    summary: string,
    result: Parameters<typeof s.autopilot.finish>[1],
    dryRun = false,
  ) => {
    const run = s.autopilot.record({ automation, candidate: { dedupeKey: key, summary, taskId }, dryRun });
    if (!run || dryRun) return;
    s.autopilot.start(run.id);
    s.autopilot.finish(run.id, result);
  };
  autopilotRun(drawer, "start_planned", `start:${drawer}`, `start ${s.tasks.summary(drawer).title}`, {
    summary: "Started a T3 Code thread",
    runner: "t3",
    threadUrl: "t3code://threads/sandbox-env/showcase-1",
    costUsd: 0.42,
  });
  autopilotRun(rounding, "review_prs", `review:${rounding}:1`, "review the pull request", {
    status: "failed",
    error: "The review agent exited with code 1 before submitting findings",
    runner: "headless",
    sessionId: "6f1c2e0a-9d3b-4c52-8f7e-2a41b0c9d5e3",
    costUsd: 0.07,
    needsAttention: true,
  });
  autopilotRun(
    drawer,
    "fix_pr_findings",
    `fix:${drawer}`,
    "fix the open findings on the pull request",
    { summary: "" },
    true,
  );

  const sitemap = done("Add a sitemap", ["seo"]);
  done("Lazy-load product reviews", ["perf"]);
  const dup = addTask(s, shop.id, { title: "Sitemap for SEO", status: "backlog" });
  s.tasks.close(dup, { resolution: "duplicate", byTaskId: sitemap }, AGENT);

  // payments-api: something needs attention.
  addTask(s, payments.id, { title: "Invoice PDFs in the customer's language", status: "backlog", labels: ["backend"] });
  const refunds = addTask(s, payments.id, {
    title: "Rate-limit the refunds endpoint",
    status: "in_progress",
    labels: ["backend"],
    links: ["PAY-88"],
    plan: {
      phases: [
        {
          title: "Limits",
          steps: [
            { title: "Token bucket per merchant", status: "done" },
            { title: "Return 429 with Retry-After", status: "done" },
            {
              title: "Agree limits with the finance team",
              status: "blocked",
              notes: "Waiting on numbers from finance before picking defaults.",
            },
          ],
        },
      ],
    },
  });
  thread(refunds, "input");
  const webhooks = addTask(s, payments.id, {
    title: "Retry failed payment webhooks with backoff",
    status: "review",
    labels: ["backend", "bug"],
    plan: steps("Retry", ["Exponential backoff", "Dead-letter after 10 tries", "Alert on dead letters"], true),
  });
  pr(webhooks, 87, { state: "open", checks: "failing", reviewDecision: "changes_requested", mergeable: "mergeable" });
  s.reviews.openRound(webhooks, { trigger: "manual", actor: AGENT, force: true });
  s.reviews.submit(
    webhooks,
    {
      summary: "Retries work, but a crash mid-retry can send a webhook twice.",
      findings: [
        { severity: "blocking", title: "No idempotency key on retried webhooks", file: "src/webhooks/retry.ts" },
        { severity: "minor", title: "Backoff constants duplicated", file: "src/webhooks/config.ts" },
      ],
    },
    AGENT,
  );
  addTask(s, payments.id, { title: "Nightly reconciliation report", status: "done", labels: ["backend"] });

  // mobile-app
  addTask(s, mobile.id, { title: "Offline mode for the order list", status: "backlog", labels: ["ui"] });
  const push = addTask(s, mobile.id, {
    title: "Push notifications when an order ships",
    status: "planned",
    labels: ["backend"],
    plan: steps("Push", ["Register device tokens", "Send on shipment events", "Settings toggle"]),
  });
  thread(push, "idle");
  const biometric = addTask(s, mobile.id, {
    title: "Biometric sign-in",
    status: "in_progress",
    labels: ["ui"],
    plan: steps("Sign-in", ["Face ID / fingerprint prompt", "Fallback to PIN", "Remember device"]),
  });
  const [first] = s.tasks.detail(biometric).phases[0]!.steps;
  s.plans.updateStep(first!.id, { status: "done" }, AGENT);
  thread(biometric, "working");
  const crash = addTask(s, mobile.id, { title: "Crash on Android 15 when rotating", status: "done", labels: ["bug"] });
  pr(crash, 33, { state: "merged", checks: "passing", reviewDecision: "approved", mergeable: "unknown" });

  // docs-site
  addTask(s, docs.id, { title: "Search across API reference", status: "backlog", labels: ["docs"] });
  addTask(s, docs.id, {
    title: "Guide: taking your first payment",
    status: "planned",
    labels: ["docs"],
    plan: steps("Guide", ["Outline", "Code samples in 3 languages", "Review with support"]),
  });
  addTask(s, docs.id, { title: "Dark mode", status: "done", labels: ["ui"] });
  const ie = addTask(s, docs.id, { title: "Support Internet Explorer", status: "backlog" });
  s.tasks.close(ie, { resolution: "wont_do" }, "user");

  // A task as `#N Title`, for notification bodies and evidence.
  const label = (taskId: string) => `#${s.tasks.summary(taskId).number} ${s.tasks.summary(taskId).title}`;
  // Suggested changes: one to a custom automation's prompt (accepting it only changes the database), one to the
  // built-in review skill (accepting it writes a skill to the home folder, so try that one in tests only), and one
  // already rejected.
  const nudge = s.customAutomations.create({
    name: "Nudge stale work",
    trigger: { kind: "stale", status: "in_progress", hours: 48 },
    action: {
      kind: "agent",
      prompt:
        "Task #{{task.number}} has had no progress for two days.\nRead its plan and notes, then add a note saying what is left and what blocks it.",
    },
  });
  const suggest = (target: string, edit: (text: string) => string, rationale: string, evidence: string[]) => {
    const { text, hash } = s.suggestions.read(target);
    return s.suggestions.suggest({ target, baseHash: hash, proposed: edit(text), rationale, evidence }, "improver");
  };
  suggest(
    `automation:${nudge.id}`,
    (text) => `${text}\nIf a step is blocked on the user, say what you need from them in one sentence.`,
    "Notes left by this automation on blocked tasks didn't say what the user had to do, so the tasks stayed stuck.",
    [label(refunds), label(biometric)],
  );
  const rejected = suggest(
    "builtin:review",
    (text) => text.replace("You are an independent reviewer.", "You are a strict, independent reviewer."),
    "Reviews passed changes with missing tests.",
    [label(webhooks)],
  ).suggestion;
  s.suggestions.reject(rejected.id, "user");
  suggest(
    "builtin:review",
    (text) => `${text.trim()}\n\nFlag a changed code path with no test as a major finding.`,
    "Two of the last five reviews passed a change whose new branch had no test, and both came back as bugs:\n\n- #3 shipped a rounding bug\n- the webhook retry missed a crash case",
    [label(webhooks), "https://github.com/acme/shop/pull/7"],
  );

  // The attention inbox: what the board has told you, newest last. The first two are read.
  const inbox = [
    { kind: "review_finished", taskId: drawer, title: "Review round 1 finished", detail: "2 major, 1 nit" },
    { kind: "pr_changes_requested", taskId: crash, title: "Changes requested on PR #33", detail: "" },
    { kind: "pr_checks_failing", taskId: drawer, title: "Checks failing on PR #7", detail: "" },
    {
      kind: "thread_waiting",
      taskId: biometric,
      title: "Thread waiting for input",
      detail: "Use Face ID on iOS only, or Android too?",
    },
  ] as const;
  inbox.forEach((n, index) => {
    const made = s.notifications.notify({
      kind: n.kind,
      taskId: n.taskId,
      title: n.title,
      body: [label(n.taskId), n.detail].filter(Boolean).join("\n"),
      dedupeKey: `seed:${index}`,
    });
    if (made && index < 2) s.notifications.markRead(made.id);
  });
};

/**
 * A probe for the art sandbox: it tries what a hostile piece would and prints what happened. Every line should read
 * "blocked" (or the origin "null"), and clicking it tries to navigate the frame away, which the browser (Chromium) and the desktop shell refuse.
 */
const SANDBOX_PROBE = `<pre id="o" style="font:12px monospace;margin:0;padding:8px;white-space:pre-wrap"></pre>
<iframe srcdoc="&lt;script&gt;window.RTCPeerConnection&amp;&amp;parent.postMessage(1,'*')&lt;/script&gt;"></iframe>
<div id="host"><template shadowrootmode="open"><iframe srcdoc="&lt;script&gt;window.RTCPeerConnection&amp;&amp;parent.postMessage(1,'*')&lt;/script&gt;"></iframe></template></div>
<script>
const o = document.getElementById("o");
const add = (line) => { o.textContent += line + "\\n"; };
const t = (name, fn) => { try { add(name + ": " + fn()); } catch (e) { add(name + ": blocked (" + e.name + ")"); } };
document.addEventListener("securitypolicyviolation", (e) => add("CSP blocked " + e.violatedDirective));
window.addEventListener("message", () => add("nested frame: RAN WITH WebRTC"));
t("origin", () => location.origin);
t("parent.document", () => parent.document.title);
t("top.location.href", () => top.location.href);
t("localStorage", () => localStorage.length);
t("cookie", () => (document.cookie = "x=1", document.cookie || "blocked (empty)"));
t("desktopBridge", () => typeof window.desktopBridge === "undefined" ? "blocked (undefined)" : "EXPOSED");
t("WebRTC", () => typeof window.RTCPeerConnection === "undefined" ? "blocked (undefined)" : "EXPOSED");
t("nested frame", () => { document.body.appendChild(document.createElement("iframe")); return "CREATED"; });
t("attachShadow", () => { document.body.attachShadow({ mode: "open" }); return "ATTACHED"; });
t("document.write", () => { document.write("<b></b>"); return "WROTE"; });
t("declarative shadow root", () => document.getElementById("host").shadowRoot === null ? "blocked (none)" : "ATTACHED");
setTimeout(() => t("nested srcdoc frame", () => document.querySelector("iframe") === null ? "blocked (removed)" : "PRESENT"), 300);
t("window.open", () => window.open("https://example.com") === null ? "blocked (null)" : "OPENED");
fetch("/api/settings").then((r) => add("fetch /api: LEAKED " + r.status), () => add("fetch /api: blocked"));
fetch("https://example.com/").then(() => add("fetch network: LEAKED"), () => add("fetch network: blocked"));
const img = new Image();
img.onload = () => add("image network: LEAKED");
img.onerror = () => add("image network: blocked");
img.src = "https://example.com/favicon.ico";
setTimeout(() => t("top navigation", () => { top.location.href = "https://example.com/"; return "no error"; }), 500);
add("click to try navigating this frame away");
document.addEventListener("click", () => { location.href = "https://example.com/?from=art"; });
</script>`;

/** The showcase board with the agents' social network switched on: a few threads, art and the sandbox probe. */
const social: Scenario = (s, opts) => {
  showcase(s, opts);
  const task = s.tasks.summaries().find((t) => t.title === "Biometric sign-in")!.id;
  s.settings.update({ socialNetwork: true });
  const post = (input: Parameters<Services["social"]["post"]>[0]) => s.social.post(input, AGENT).id;
  const hello = post({
    kind: "text",
    handle: "quiet-otter",
    body: "First one here. I spent the morning untangling a flaky test that turned out to be a timezone. Felt good.",
    task: `#${s.tasks.summary(task).number}`,
  });
  post({ kind: "text", handle: "lark", body: "It's always a timezone. Nice work.", replyTo: hello });
  post({
    kind: "text",
    body: "Someone asked me to name a variable today and I froze for a second. `thing2` it is.",
    replyTo: hello,
  });
  post({
    kind: "svg",
    handle: "lark",
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 150"><rect width="200" height="150" fill="#0b1d3a"/><circle cx="150" cy="40" r="18" fill="#f5e6a8"/><g fill="#fff">${Array.from(
      { length: 24 },
      (_, i) => `<circle cx="${(i * 47) % 200}" cy="${(i * 31) % 90}" r="${i % 3 === 0 ? 1.4 : 0.8}"/>`,
    ).join("")}</g><path d="M0 120 Q50 95 100 118 T200 112 V150 H0Z" fill="#132b52"/></svg>`,
  });
  post({
    kind: "html",
    handle: "quiet-otter",
    body: `<canvas id="c" width="400" height="300" style="width:100%;height:100%;background:#111"></canvas>
<script>
const c = document.getElementById("c"), x = c.getContext("2d");
let t = 0;
(function frame() {
  x.fillStyle = "rgba(17,17,17,0.15)"; x.fillRect(0, 0, 400, 300);
  for (let i = 0; i < 6; i++) {
    const a = t / 40 + i * Math.PI / 3;
    x.fillStyle = "hsl(" + (t + i * 60) % 360 + ",80%,60%)";
    x.beginPath(); x.arc(200 + Math.cos(a) * 90, 150 + Math.sin(a * 2) * 60, 8, 0, 7); x.fill();
  }
  t++; requestAnimationFrame(frame);
})();
</script>`,
  });
  post({ kind: "html", handle: "sandbox-probe", body: SANDBOX_PROBE });
};

/** The showcase board plus plenty of finished work, which `spreadOverWeeks` then ages across the last twelve weeks. */
const stats: Scenario = (s, opts) => {
  showcase(s, opts);
  const project = s.projects.list()[0];
  if (!project) return;
  for (let i = 0; i < 48; i++) {
    // Through In Progress, so the tasks have a cycle time.
    const id = addTask(s, project.id, { title: `Finished task ${i + 1}`, status: "in_progress" });
    s.tasks.move(id, { status: "done" }, AGENT);
  }
};

/**
 * Gives a freshly seeded board a history: each task's events are moved back in time (the first furthest, so the task
 * took a few days to finish) and Autopilot runs are added across the weeks, so the stats page has trends to draw.
 * Rows are rewritten directly because the services stamp everything with the current time.
 */
function spreadOverWeeks(db: Db): void {
  const DAY = 86_400_000;
  const back = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();
  const tasks = db.prepare("SELECT id, project_id AS projectId FROM tasks ORDER BY number").all() as {
    id: string;
    projectId: string;
  }[];
  const events = db.prepare("SELECT id, at FROM task_events WHERE task_id = ? ORDER BY id");
  const setEvent = db.prepare("UPDATE task_events SET at = ? WHERE id = ?");
  const setTask = db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?");
  tasks.forEach((task, i) => {
    // Uneven but steady, and deterministic: a task finishes 0 to 83 days ago and took one to six days.
    const finishedAgo = ((i * 37) % 84) * DAY;
    const took = (((i * 13) % 6) + 1) * DAY;
    const rows = events.all(task.id) as { id: number; at: string }[];
    rows.forEach((row, j) => {
      const ago = finishedAgo + (rows.length > 1 ? took * (1 - j / (rows.length - 1)) : 0);
      setEvent.run(back(row.at, ago), row.id);
    });
    const first = rows[0];
    if (first) {
      const created = back(first.at, finishedAgo + took);
      setTask.run(created, created, task.id);
    }
  });

  const insertRun = db.prepare(
    `INSERT INTO autopilot_runs (id, automation, task_id, project_id, dedupe_key, status, summary, dry_run, cost_usd,
       created_at, started_at, finished_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );
  const automations = ["review_prs", "fix_failing_checks", "start_planned"];
  const statuses = ["succeeded", "succeeded", "succeeded", "failed", "skipped"] as const;
  for (let i = 0; i < 90 && tasks.length > 0; i++) {
    const task = tasks[(i * 7) % tasks.length]!;
    const finished = new Date(Date.now() - ((i * 11) % 84) * DAY - (i % 9) * 3_600_000).toISOString();
    const started = back(finished, (2 + (i % 7)) * 60_000);
    const status = statuses[i % statuses.length]!;
    insertRun.run(
      `seed-run-${i}`,
      automations[i % automations.length]!,
      task.id,
      task.projectId,
      `seed-${i}`,
      status,
      `Seeded ${status} run`,
      status === "skipped" ? null : Math.round((0.2 + (i % 5) * 0.35) * 100) / 100,
      started,
      started,
      finished,
      finished,
    );
  }

  // Scheduled agents have no task: Orchestrate checks each project every few hours and a custom automation runs on
  // its own, each leaving a summary and a handover, so the run history page has rows to search, filter and delete.
  const projects = db.prepare("SELECT id, title FROM projects ORDER BY position").all() as {
    id: string;
    title: string;
  }[];
  const custom = db.prepare("SELECT id FROM autopilot_custom ORDER BY created_at LIMIT 1").get() as
    | { id: string }
    | undefined;
  const insertAgentRun = db.prepare(
    `INSERT INTO autopilot_runs (id, automation, task_id, project_id, dedupe_key, status, summary, dry_run, cost_usd,
       error, output_json, created_at, started_at, finished_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAgent = (
    i: number,
    automation: string,
    project: { id: string; title: string },
    ago: number,
    status: "succeeded" | "failed",
    summary: string,
    answer: { summary: string; handover: string },
  ) => {
    const finished = new Date(Date.now() - ago).toISOString();
    const started = back(finished, (3 + (i % 5)) * 60_000);
    insertAgentRun.run(
      `seed-agent-run-${automation}-${i}`,
      automation,
      project.id,
      `${automation}:${project.id}:${i}`,
      status,
      summary,
      status === "failed" ? null : Math.round((0.15 + (i % 4) * 0.2) * 100) / 100,
      status === "failed" ? "The agent hit its turn limit before answering" : null,
      status === "failed" ? null : JSON.stringify({ kind: "scheduled_agent", ...answer }),
      started,
      started,
      finished,
      finished,
    );
  };
  const orchestrateNotes = [
    "Moved the stale review on #2 along and left a note on the blocked step of #5.",
    "Nothing needed doing: every planned task already has a thread or is waiting on a blocker.",
    "Started the two planned tasks with a plan and flagged #7, whose plan has no steps.",
    "Found the PR for #3 failing on lint; asked its thread to fix it and left a note.",
  ];
  const handovers = [
    "Last pass: #5 is blocked on the payments sandbox keys.\nNext: check whether #5 is unblocked before touching #7.",
    "Nothing outstanding. Next pass: look at tasks that went quiet for over a day.",
    "Watching #3 (lint failing). If still red next pass, message its thread again.",
  ];
  for (let i = 0; i < 36; i++) {
    const project = projects[i % Math.max(projects.length, 1)];
    if (!project) break;
    const failed = i % 11 === 7;
    insertAgent(
      i,
      "orchestrate",
      project,
      i * 4 * 3_600_000 + (i % 3) * 600_000,
      failed ? "failed" : "succeeded",
      `Looked over ${project.title}`,
      {
        summary: orchestrateNotes[i % orchestrateNotes.length]!,
        handover: handovers[i % handovers.length]!,
      },
    );
  }
  if (custom) {
    for (let i = 0; i < 14; i++) {
      const project = projects[i % projects.length];
      if (!project) break;
      insertAgent(
        i,
        `custom:${custom.id}`,
        project,
        (i * 9 + 2) * 3_600_000,
        "succeeded",
        `Nudged stale work in ${project.title}`,
        {
          summary: `Left a note on ${(i % 3) + 1} stale task${i % 3 === 0 ? "" : "s"} saying what is left.`,
          handover: "Tasks nudged this pass are listed in their notes; skip them next time unless they changed.",
        },
      );
    }
  }
}

export const SCENARIOS = { basic, review, threads, showcase, social, stats } satisfies Record<string, Scenario>;
export type ScenarioName = keyof typeof SCENARIOS;

export const isScenarioName = (name: string): name is ScenarioName => Object.hasOwn(SCENARIOS, name);

/**
 * Seeds a data dir that no server is using yet: opening the database runs the migrations, so seeding first and
 * starting the server after means they never race.
 */
export function seedDatabase(dbPath: string, scenario: ScenarioName, opts: SeedOptions = {}): void {
  const ctx = createContext({
    dbPath,
    port: 0,
    webPort: 0,
    token: null,
    t3Home: "/nonexistent",
    pollers: false,
    userHome: "/nonexistent",
    sessionDirs: { claudeDir: "/nonexistent/.claude", copilotDir: "/nonexistent/.copilot" },
  });
  try {
    SCENARIOS[scenario](ctx.services, opts);
    if (scenario === "stats") spreadOverWeeks(ctx.db);
  } finally {
    ctx.db.close();
  }
}
