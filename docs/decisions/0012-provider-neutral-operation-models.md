# 0012 One model choice per operation, with no provider assumed

Status: Accepted

## Context

There were three ways to say which model something runs on. The reviewer and issue import had a `HeadlessModel` (a
tier or a typed model, and no custom models). Automations had a `ModelChoice` (`{from: "task"} | {tier} | {profile}`)
plus a free-text `model` override that won over it. A custom agent action had a bare `tier`, and the digest only free
text. Some choices were hard-coded: Ask ran `haiku`, the digest the light tier, Orchestrate the standard tier. Two
resolvers turned a tier into a Claude Code model and disagreed (`resolveHeadlessModel` ignored a T3 model that
`profileHeadlessModel` took), and two pairs of helpers did the same thing (`tierCliModel` and `profileCliModel`).

Claude Code was assumed throughout: a tier's headless harness defaulted to it, a run its harness couldn't do fell
back to it without asking whether the user had it, and issue import defaulted to one of its models. Since providers
became opt-in (ADR 0011), someone with only Codex got runs aimed at a CLI they never added. Runs kept no record of
the provider and model they ran on, only a line of text.

## Decision

- **One type.** `ModelChoice = "inherit" | {tier} | {profile} | {provider, model, effort?}` names a model everywhere:
  the board's per-operation setting, automation configs, custom actions, the digest, and task and project reviewer
  overrides. A typed model always names its provider.
- **An operation registry.** `OPERATIONS` lists every operation that runs a model (task runs, PR fix, new sessions,
  the reviewer subagent, the board reviewer, PR review, Orchestrate, the digest, custom agents with and without a
  task, issue import, Ask) with what it needs from the provider (structured output, the untrusted lockdown, no tools,
  tool rules, edit) and a default. A default is a tier or inherit, never a provider's model. The board setting
  `operationModels` overrides any of them.
- **One precedence.** Task reviewer override, project reviewer override, the automation's config, its action's own
  choice, the board's setting, the default; inherit defers to the next. At the bottom a task-scoped operation takes
  the task's model (a label's custom model, its tier), and everything else the light tier.
- **One resolver, in contracts.** `resolveOperationModel` picks only providers that are added, switched on and able
  to do what the operation and the run need: a tier's preferred provider (`ModelTierSetting.provider`, which has no
  default), else the first such provider in the user's order with a model for it. It is pure, so the settings page
  can show what each operation resolves to.
- **Refuse, never substitute.** When no provider can run an operation it refuses with a reason the user can act on.
  It never runs something else quietly. Every fallback it does make is noted on the run.
- **Runs record their model.** `autopilot_runs.model_json` keeps `{provider, model, effort, source}`.
- **Migrations keep what ran.** `041_operation_models` rewrites every stored choice to the new shape, a typed model as
  that model on the provider it actually ran on. Defaults that were never saved take the new defaults. An automation
  bundle from before still imports: its `tier` reads as the action's `model`.

## Consequences

- Ask runs on the light tier instead of `haiku` for anyone who never chose its model, and issue import likewise.
- An install with no capable provider gets refusals where it used to get Claude Code runs: an Ask error, an
  issue-import failure, a failed board review round, a failed Autopilot run. Today only Claude Code meets the needs of
  the board reviewer, PR review, Orchestrate, the digest, issue import and Ask; #76 lets Codex and Copilot take the
  ones their drivers can.
- The MCP `reviewModel` takes a tier, a custom model's id or `provider:model`; a bare id is refused with the added
  providers to put in front of it, since which provider runs it can't be guessed.
- A new operation is an `OperationId`, an `OPERATIONS` entry, and an `operation` on its `RunnerRequest` or a
  `resolveOperationModel` call.
