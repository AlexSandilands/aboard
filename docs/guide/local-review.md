# Local review

Local review gets an agent's work reviewed before it opens a pull request. It's off by default; turn it
on in **Settings → Tasks → Review**.

When an agent moves a task to Review, the board tells it to run a review loop:

1. A fresh reviewer subagent reads the change and records findings on the task.
2. The agent fixes them, or says why it won't.
3. The loop repeats until nothing blocking is left.

The card shows the review state, and the task panel lists every finding and how it was resolved.

The reviewer follows the built-in review skill, or any skill you have installed for Claude Code, Copilot
or Codex, chosen per project if you like. If no agent runs the review, the board nudges the task's T3
Code thread, and can run the review itself with Claude Code headless.

How it works: [docs/features/local-review.md](../features/local-review.md).
