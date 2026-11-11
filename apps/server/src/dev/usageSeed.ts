import { EMPTY_TOKEN_USAGE, type TokenUsage } from "@repo/contracts";
import type { Db } from "../db/database.ts";
import { createRepos } from "../db/repos/index.ts";
import type { UsageRow } from "../db/repos/sessionUsage.ts";
import type { Services } from "../services/types.ts";

// Token usage for the sandbox's stats scenario (docs/features/token-usage.md): one task that shows every kind of row
// in the panel, and twelve weeks of history over the board's other linked sessions for the stats page. The session
// ids are made up, so no transcript is ever read for them; the rows are written straight to the table.

const AGENT = "seed";
const SESSION = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

const t = (patch: Partial<TokenUsage>): TokenUsage => ({ ...EMPTY_TOKEN_USAGE, ...patch });

const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgo = (n: number) => dayOf(new Date(Date.now() - n * 86_400_000));

/** A small deterministic generator, so every seeded sandbox shows the same charts. */
function random(seed: number) {
  let x = seed;
  return () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
}

export function seedUsage(s: Services, db: Db, opts: { workspaceRoot?: string } = {}): void {
  const project = s.projects.list()[0];
  if (!project) return;
  const usage = createRepos(db).sessionUsage;
  const cwd = opts.workspaceRoot ?? "/work/usage";
  const plan = { phases: [{ title: "Build", steps: [{ title: "Read the transcripts" }, { title: "Show the cost" }] }] };
  const row = (
    over: Partial<UsageRow> & Pick<UsageRow, "harness" | "sessionId" | "day" | "model" | "tokens">,
  ): UsageRow => ({
    sourceFile: "seed.jsonl",
    source: "transcript",
    taskId: null,
    purpose: null,
    reportedCostUsd: null,
    ...over,
  });

  // The showcase task: one of each kind of row the panel shows.
  const showcase = s.tasks.create({
    projectId: project.id,
    title: "Token usage across every harness",
    plan,
    labels: ["agent-dx"],
  });
  s.tasks.move(showcase.id, { status: "in_progress" }, AGENT);
  const other = s.tasks.create({ projectId: project.id, title: "Plan the usage panel", plan });
  const link = (taskId: string, harness: "claude-code" | "codex" | "copilot-cli", n: number, label?: string) =>
    s.links.add(taskId, { agentSession: { harness, sessionId: SESSION(n), cwd }, ...(label ? { label } : {}) }, AGENT);
  // Planned in a session the other task linked first, so it is shared.
  link(other.id, "claude-code", 4, "Planning the usage panel");
  link(showcase.id, "claude-code", 1, "Implementing the usage panel");
  link(showcase.id, "codex", 2, "Codex second pass");
  link(showcase.id, "copilot-cli", 3, "Copilot session");
  link(showcase.id, "claude-code", 4, "Planning the usage panel");
  s.links.add(showcase.id, { t3Thread: { environmentId: "seed-env", threadId: "seed-usage-thread" } }, AGENT);
  usage.setThreadSessions("seed-usage-thread", [{ harness: "t3", sessionId: "seed-usage-thread" }]);
  usage.add([
    row({
      harness: "claude-code",
      sessionId: SESSION(1),
      day: daysAgo(1),
      model: "claude-opus-5-5",
      tokens: t({ input: 12_400, output: 61_000, cacheRead: 690_000, cacheWrite1h: 79_000 }),
    }),
    row({
      harness: "claude-code",
      sessionId: SESSION(1),
      sourceFile: "subagents/agent-1.jsonl",
      day: daysAgo(1),
      model: "claude-haiku-5-5",
      tokens: t({ input: 4_000, output: 9_000, cacheRead: 120_000 }),
    }),
    row({
      harness: "codex",
      sessionId: SESSION(2),
      day: daysAgo(0),
      model: "gpt-5.2-codex",
      tokens: t({ input: 41_000, output: 22_000, cacheRead: 247_000 }),
    }),
    row({
      harness: "claude-code",
      sessionId: SESSION(4),
      day: daysAgo(3),
      model: "claude-opus-5-5",
      tokens: t({ input: 6_000, output: 14_000, cacheRead: 168_000, cacheWrite5m: 22_000 }),
    }),
    // A T3 thread on a remote machine, counted from T3's turns: one priced model and one with no price.
    row({
      harness: "t3",
      sessionId: "seed-usage-thread",
      sourceFile: "pt-1",
      source: "t3_turn",
      day: daysAgo(2),
      model: "claude-sonnet-5-5",
      tokens: t({ input: 9_000, output: 48_000, cacheRead: 930_000, cacheWrite5m: 113_000 }),
    }),
    row({
      harness: "t3",
      sessionId: "seed-usage-thread",
      sourceFile: "pt-2",
      source: "t3_turn",
      day: daysAgo(2),
      model: "glm-4.6",
      tokens: t({ input: 21_000, output: 6_000, cacheRead: 27_000 }),
    }),
    // The board reviewer, which keeps no transcript: its own output, with the cost it reported.
    row({
      harness: "claude-code",
      sessionId: "seed-review-1",
      sourceFile: "",
      source: "run_output",
      day: daysAgo(0),
      model: "claude-sonnet-5-5",
      taskId: showcase.id,
      purpose: "review",
      reportedCostUsd: 0.38,
      tokens: t({ input: 4_000, output: 9_000, cacheRead: 150_000, cacheWrite5m: 18_000 }),
    }),
  ]);

  // History: a session on each finished task, then every linked session gets a few days of use over twelve weeks.
  const next = random(152);
  const harnesses = ["claude-code", "claude-code", "codex", "copilot-cli"] as const;
  s.tasks
    .summaries({ projectId: project.id, status: "done" })
    .forEach((task, i) => link(task.id, harnesses[i % harnesses.length]!, 1000 + i));
  const models: Record<string, string[]> = {
    "claude-code": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    codex: ["gpt-5.2-codex", "gpt-5.1"],
  };
  const { sessions } = usage.linkedSources();
  const rows: UsageRow[] = [];
  for (const session of sessions) {
    // The showcase's own sessions keep exactly the rows above.
    if (Number(session.sessionId.slice(-12)) < 1000 && session.sessionId.startsWith("00000000-0000-4000-9000"))
      continue;
    // No reader for Copilot CLI yet, so a real board never has its rows either (token-usage.md#copilot-cli).
    if (session.harness === "t3" || session.harness === "copilot-cli") continue;
    const days = 1 + Math.floor(next() * 4);
    for (let i = 0; i < days; i++) {
      const pick = models[session.harness]!;
      const scale = 0.3 + next() * 1.4;
      rows.push(
        row({
          harness: session.harness,
          sessionId: session.sessionId,
          day: daysAgo(Math.floor(next() * 84)),
          model: pick[Math.floor(next() * pick.length)]!,
          tokens: t({
            input: Math.round(20_000 * scale),
            output: Math.round(45_000 * scale),
            cacheRead: Math.round(900_000 * scale),
            cacheWrite5m: Math.round(60_000 * scale),
          }),
        }),
      );
    }
  }
  // Autopilot's own runs with no session kept, for the overhead tile and the by-automation bars.
  const purposes = ["review_prs", "fix_prs", "review", "improve", "digest"];
  for (let i = 0; i < 30; i++) {
    const purpose = purposes[Math.floor(next() * purposes.length)]!;
    rows.push(
      row({
        harness: "claude-code",
        sessionId: `seed-run-${i}`,
        sourceFile: "",
        source: "run_output",
        day: daysAgo(Math.floor(next() * 84)),
        model: "claude-sonnet-5-5",
        purpose,
        reportedCostUsd: Number((0.1 + next() * 0.9).toFixed(2)),
        tokens: t({ input: 3_000, output: 8_000, cacheRead: 140_000, cacheWrite5m: 15_000 }),
      }),
    );
  }
  usage.add(rows);
}
