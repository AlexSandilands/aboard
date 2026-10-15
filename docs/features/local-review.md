# Local review

Board task: #1. Verified against Claude Code 2.1.300 and T3 Code 0.0.46 (October 2026).

Local review gets a task's code reviewed, and the findings fixed, before a pull request exists. The aim is
that you come back to a card in Review whose work has already been reviewed and fixed, without having asked
for a review or relayed what it found.

## How it works

### The loop

Turn it on in Settings → Local review ("Review before the PR"). A task can override the setting in its
panel (Auto: Default / On / Off), or an agent can with `update_task(autoReview)`.

1. The implementing agent finishes and calls `move_task` to `review`. The board opens **review round 1**.
   The `move_task` result tells the agent to run the loop and includes a **reviewer brief**.
2. The agent starts a **reviewer subagent with fresh context** (Claude Code's Agent tool, a Copilot
   subagent) and gives it the brief. A subagent call blocks, so "the review has finished" simply means
   the call returned.
3. The reviewer reads the task (`get_task`) and the branch's diff, then records its findings with
   `submit_review`. It never edits files.
4. The agent fixes the findings and marks each one with `resolve_finding`: `fixed`, or `wont_fix` with a
   note saying why.
5. If the round raised blocking or major findings, the agent calls `start_review` for the next round,
   with a new reviewer. It stops when a round comes back clean, or after the round limit (3 by default).
6. Only then does it open the pull request.

One round is one subagent call. Everything that has to survive between rounds lives on the board: every
finding, every resolution note, every verdict. A new reviewer reads that history through `get_task`, so it
checks the earlier fixes without inheriting the previous reviewer's blind spots. That also leaves an audit
trail on the task.

A round is **clean** when it raises no blocking or major findings and none are open from earlier rounds.
Minor findings and nits may stay open.

### Findings

| Severity | Meaning | Sends the change back |
|---|---|---|
| blocking | Wrong behaviour, data loss, a security hole, or the task isn't done | Yes |
| major | A likely bug, a risky edge case, or a changed path with no test | Yes |
| minor | Maintainability: duplication, unclear code, a weak test | No |
| nit | Small polish | No |

Findings are labelled `R<round>.<n>` (`R2.3` is round 2, finding 3), which is how agents refer to them in
`resolve_finding`. In the panel you can mark a finding fixed, decline it with a reason, or reopen it.

Rounds belong to a **cycle**. Each move to Review starts a new cycle, and the round limit applies per
cycle, so a task that goes back to In Progress after a clean review can be reviewed again. Round numbers
keep counting across cycles.

### Review skills

The reviewer follows a skill:

- **aboard-review** (built in, the default). Its text ships in `packages/contracts/src/reviewPrompt.ts` and
  is included in the brief, so it works from the packaged app with nothing installed.
  `skills/aboard-review/SKILL.md` is the same text as an installable skill; a test keeps the two identical.
- **Any SKILL.md on disk.** The settings list skills from `~/.claude/skills`, `~/.copilot/skills`,
  `~/.codex/skills` and `~/.agents/skills`. A project can pick one of its own in project settings, from its
  `.claude/skills`, `.github/skills` or `.agents/skills` folder. The brief then names the skill and its
  absolute path, so a harness that doesn't have it installed can still read it.

### The card

The review state shows as a badge on the card, not as a column: *Reviewing*, *N open*, *Fixed, re-review*,
*Reviewed*, *Needs review*, *Stuck* or *Review failed*. While the loop runs it's the agent's business. The
card only asks for your attention when the loop ended without a clean result:

- **Stuck:** blocking or major findings are still open after the last round.
- **Needs review:** nobody ran the round and no fallback could.
- **Review failed:** the board's reviewer couldn't finish (the reason is on the round).
- **Board review: N to fix:** the board's own reviewer found problems that no agent is looping on.

### Fallbacks: when no agent runs the round

Sometimes nobody runs the round: you dragged the card to Review yourself, pressed **Run review**, or the
agent stopped without reviewing. A watchdog checks pending rounds every 30 seconds and works through the
fallbacks in order:

1. **Wait.** An agent's round gets 30 minutes, counted from the task's last activity: its reviewer only
   reports when it submits, so the implementer updating steps or notes counts as a sign the loop is still
   going. After a nudge the wait is 10 minutes. A round you opened yourself skips the first wait. The
   watchdog also waits while the task's T3 thread is busy (working, or waiting on you).
2. **Nudge the T3 thread.** If the task has a linked T3 thread, the board posts the loop instructions into
   it, and the agent there runs the loop. This uses the same token and WebSocket RPC as starting a T3 Code thread
   (`orchestration.dispatchCommand` with a `message.dispatch` command and `deliveryIntent: "auto"`, so T3
   starts a turn or queues it behind the running one). The command id is stable per round, so a retry
   doesn't post twice. It needs the `orchestration:operate` scope.
3. **The board reviewer.** If it's on (Settings → Local review → Board reviewer), the board reviews the
   round itself with Claude Code headless. If an agent's reviewer submits while it runs, the agent's review
   stands and the board's is dropped. Moving the task to Review meanwhile isn't blocked; the running review
   covers it. When it finds blocking or major issues and a T3 thread is linked,
   it posts a "fix these findings" prompt into the thread. Otherwise the card asks for attention.
4. **Otherwise** the round is marked stalled and the card shows *Needs review*. The panel's **Copy prompt**
   copies the loop (or, after a board review, the fix instructions) for any harness.

#### The board reviewer

The board runs `claude -p` in the task's checkout: the linked T3 thread's worktree when T3 reports one,
else the project folder. One review runs at a time.

- **Read-only:** `--permission-mode dontAsk` with `--allowedTools` limited to Read, Grep, Glob and read-only
  git (`git diff`, `log`, `show`, `status`, `merge-base`, `rev-parse`). Edit, Write and NotebookEdit are
  disallowed outright.
- **No MCP servers** (`--strict-mcp-config`). Your global config may register this board, and the reviewer
  must not record the round itself as well. The task's text is included in the prompt instead.
- **Structured output:** `--json-schema` makes Claude Code return the summary and findings as JSON, which
  the board records under the actor "board reviewer". The round's summary shows what the review cost.
- **Windows shims:** a `claude.cmd` (npm install) runs through cmd.exe with its arguments escaped twice,
  because the shim expands them again; the schema and paths with spaces survive intact.
- **Capped:** `--max-budget-usd` (Settings, default $2) and a 20-minute timeout. `--no-session-persistence`
  keeps these runs out of your session history.

Git commands in the instructions are plain commands, one per step. `dontAsk` denies `$(...)`
substitutions, and an early version that used `git diff $(git merge-base …)` reviewed the files without
the diff.

The Test button next to the CLI setting runs `claude --version` with the configured path (empty means
`claude` on PATH).

## Decisions

### The agent runs the loop, not the board

The first idea was the reverse: the board runs `claude -p` as the reviewer whenever a task reaches Review,
and posts the findings into the task's T3 thread. It was set aside as the main path because of the
direction findings have to travel:

- The board can always *produce* findings. The hard part is getting the implementing agent to act on them.
  The board can only push into **T3** threads. A plain Claude Code session or a Copilot session has no
  inbound channel: MCP lets the agent call the board, but nothing lets the board start a turn. Claude
  Code's SendMessage only reaches local Claude sessions.
- So with a board-run reviewer, anyone not using T3 would have to come back and tell their agent to look
  at the review: the manual step this feature exists to remove.
- When the agent moves the task to Review it is **still mid-turn**, so handing it the loop in the
  `move_task` result needs no channel at all. Claude Code, Copilot and Codex all support subagents and the
  SKILL.md format, so the same loop works in each.
- The reviewer stays independent: it's a fresh subagent with its own context, guided by a review skill.
  And it runs on the user's own harness and subscription.

The board-run reviewer survives as fallback 3, where it fits: rounds nobody else will run.

### Other decisions

- **No column.** A Local Review column between In Progress and Review was the original idea. The board is
  already short of width, and cards narrower than now get too busy, so review state is a badge.
- **No gate.** Moving to Review is never blocked by open findings; the card signals instead.
- **Review before the PR.** With auto-review on, "Review" means "done, being reviewed locally", and the PR
  is opened once the loop is clean. Without it, agents open and link the PR before moving to Review, as
  before.
- **`get_task` shows a pointer, not the loop.** The reviewer reads the task with `get_task` too. If that
  result told it to start a reviewer subagent, it might start one of its own. So `get_task` only says that a
  round is waiting and who does what; the loop instructions come from `move_task` and `start_review`.
- **Forgiving submissions.** `submit_review` without an open round opens one, so a review run outside the
  loop still gets recorded.

## Code map

| File | What it does |
|---|---|
| `packages/contracts/src/reviews.ts` | Schemas, `deriveReviewSummary` (the badge), severities, inputs |
| `packages/contracts/src/reviewPrompt.ts` | The built-in skill, reviewer brief, loop and fix instructions |
| `apps/server/src/db/migrations/004_local_review.sql` | `task_reviews`, `review_findings`, overrides |
| `apps/server/src/services/reviews.ts` | Rounds, submissions, resolutions, effective settings |
| `apps/server/src/mcp/tools/reviews.ts` | `start_review`, `submit_review`, `resolve_finding` |
| `apps/server/src/skills.ts` | Skill discovery |
| `apps/server/src/integrations/reviewFallbacks.ts` | The watchdog and fallback chain |
| `apps/server/src/integrations/headlessReview.ts` | The board reviewer (`claude -p`) |
| `apps/web/src/components/review/` | Card badge and the panel's Local review section |
| `apps/web/src/components/settings/ReviewSettingsSection.tsx` | Settings |
