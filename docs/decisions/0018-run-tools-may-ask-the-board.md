# 0018 A run tool may ask the board for work, bound to the run's scope

Status: Accepted

Amends [0013](0013-board-served-run-tools.md), whose run tools only read; it stays the rule for every tool that reads
a git host.

## Context

Orchestrate, the scheduled agent that keeps a project's work moving, had no way to put a new agent on a stalled task
except `start_task_thread`, which is T3 Code only and starts a thread at once, outside Autopilot's caps and quiet
hours (#211). A tool on the board's `/mcp` endpoint would be in every agent's list: any session could then start paid
sessions on any task, and Orchestrate, which reads text anyone can write (PR comments, CI logs), would hold a tool
that reaches every project.

## Decision

- **A run tool may write one thing: a request on the board.** `start_task_session(task, note)` is served on
  `/mcp/run` to an Orchestrate run only (tool set `orchestrate`), bound to its project the way a PR set is bound to its
  PR: a task elsewhere is refused. It records a request and returns; it starts nothing.
- **The board decides what runs.** A built-in automation (Task sessions) turns each request into one Autopilot run,
  under the user's switches, Pause all, quiet hours and caps, on the runner and provider the user set. The request's
  rules (which tasks, how often) live in the board's service, and the run checks them again.
- **No board tool starts agents for Orchestrate directly.** `start_task_thread` is on its deny list.

## Consequences

- Only an Orchestrate run sees the tool; no other agent's tool list changes, and `mcp.test.ts`'s check that every
  `/mcp` tool is placed on Orchestrate's allow or deny list doesn't cover run tools.
- A new run tool that writes has to stay as narrow: bound to the grant's target, writing a request the board
  decides on, never acting on a git host or starting work itself.
- The `orchestrate` operation now needs the `runTools` capability too, which Claude Code has; it already needed the
  untrusted lockdown and tool rules, which only Claude Code has.
