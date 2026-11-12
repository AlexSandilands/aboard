# Local review

Local review gets an agent's work reviewed before it opens a pull request. It's off by default; turn it
on in **Settings → Tasks → Review**.

When an agent moves a task to Review, the board tells it to run a review loop:

1. A fresh reviewer subagent reads the change and records findings on the task.
2. The agent fixes them, or says why it won't.
3. The loop repeats until nothing blocking is left.

The card shows the review state, and the task panel lists every finding and how it was resolved.

The reviewer follows the built-in review skill, or any skill you have installed for Claude Code, Copilot
or Codex, chosen per project if you like.

By default the reviewer runs on the same model as the agent that did the work. To have a specific model review
everything (say, Opus), pick it for **Reviewer subagent** under **Settings → Agents → Operations**: a tier, a custom
model, or any provider's model with its effort. **Board reviewer** beside it is the board's own reviewer, which runs
on the Standard tier unless you pick another; it needs a provider that can return a structured verdict, so the picker
greys out the ones that can't. **Settings → Tasks → Review** shows what both come down to, with a link. A project can
choose its own reviewer for both (**Settings → Agents → Operations → Reviewer**, with the project chosen at the top), and a task in the **Automation** section of its
panel (shown while auto-review is on for it). Agents can set the task's with `update_task`, when you ask them to. If no agent runs the review, the board nudges the task's T3
Code thread, and can run the review itself with Claude Code headless.

How it works: [docs/features/local-review.md](../features/local-review.md).
