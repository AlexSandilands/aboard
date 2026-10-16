import {
  BOARD_REVIEWER,
  type PlanInput,
  type PrSnapshot,
  type T3ThreadSnapshot,
  type TaskStatus,
} from "@repo/contracts";
import { createContext } from "../context.ts";
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
  addTask(s, shop.id, { title: "Cache product images at the edge", status: "planned" });
  addTask(s, shop.id, {
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
  addTask(s, shop.id, { title: "Inline payment form", status: "in_progress", epicId: checkout });
  addTask(s, shop.id, { title: "Merge shipping and billing steps", status: "review", epicId: checkout });
  s.tasks.create({ projectId: billing.id, title: "Usage-based pricing", kind: "epic", actor: AGENT });

  addTask(s, billing.id, { title: "Invoice PDFs in the customer's language", status: "backlog" });
  addTask(s, billing.id, { title: "Rate-limit the refunds endpoint", status: "in_progress" });
  addTask(s, billing.id, { title: "Nightly reconciliation report", status: "done" });
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
};

export const SCENARIOS = { basic, review, threads, showcase } satisfies Record<string, Scenario>;
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
  });
  try {
    SCENARIOS[scenario](ctx.services, opts);
  } finally {
    ctx.db.close();
  }
}
