# 0013 Board-served run tools

Status: Accepted

## Context

A headless run that reads untrusted text (a PR review reads a description and comments anyone can write) has to be
held to exact tools, or a prompt injection could make it read or post elsewhere. Until now only Claude Code could
be held that way: the reviewer got `Bash(gh pr diff <url>)`-style allow rules, one per exact command, on top of
`--strict-mcp-config`. Codex and the Copilot CLI have no rules that fine, so every untrusted operation was Claude Code's
alone. The `gh` rules had their own costs too: a long diff came back cut off in the agent's output, and every new
operation needed new hand-written command rules.

## Decision

- **The board serves the tools.** Each headless run that is given run tools (`RunnerRequest.runTools`) gets a token
  bound to the run, one tool set (one per kind of operation, PR review first) and one target (the PR). `POST /mcp/run`
  with that token as `Authorization: Bearer` serves that set and nothing else: no tool takes a target, so none can
  name another PR, and a board tool or any other name is refused. Any CLI that can be pointed at one MCP server is
  then held to exactly those tools.
- **The token.** 32 random bytes, kept in memory by its hash only, never logged and never in a URL or on a command
  line (any local process can read argv). It lives the run's timeout plus five minutes, at most a day, and the runner
  revokes it in a `finally` when the run ends. The board's own API token is neither needed nor accepted there, so an
  agent reading untrusted text never holds it. The localhost guard (ADR 0003) still applies.
- **How each CLI gets it.** Claude Code: `--mcp-config` with a file (mode 0600, in a temp folder outside the worktree)
  naming only the run's server with the token in a header; a locked-down run also keeps `--strict-mcp-config`.
  Codex: `--ignore-user-config` (none of the user's `config.toml`, so none of their MCP servers) plus
  `-c mcp_servers.<name>.url=…` and `bearer_token_env_var`, the token in the run's environment. The Copilot CLI can't
  yet be held to one given server, so it doesn't have the `runTools` capability and the resolver never picks it for a
  run that needs them.
- **Reads go through a `GitHost`.** The tools read through `integrations/gitHost.ts` (`getPr`, `listFiles`,
  `getDiff(path, page)`, `getComments`, `getIssue`), GitHub's on REST with the user's `gh` token (ADR 0006). Another
  git host plugs in there without touching prompts, drivers or tools.
- **Large changes are paged, never cut off.** A diff is read in pages of at most 400 lines and 20,000 characters, by
  file or for the whole PR, each result naming the next call. Only a single line longer than half a page is cut, and
  marked.
- **Writes stay with the board.** The tools only read. The agent returns structured output and the board posts it
  with its own GitHub code.

## Consequences

- PR review no longer needs `gh` or network in the agent's process, and no driver rules, so its `toolRules` need
  became `runTools`. It still needs structured output and the untrusted lockdown, which only Claude Code has today;
  #76 decides what Codex can take.
- A new operation that reads a host gets a tool set in `mcp/runTools.ts` and a `runTools` scope on its request; it
  writes no tool rules.
- Ticket import through the user's own MCP servers still uses driver tool rules: those servers aren't the board's to
  serve.
- Codex keeps its own ability to read local files; whether it can drop its shell is #76's question.
- `--ignore-user-config` also drops the rest of the user's Codex config for that run (a custom provider, say). The
  login under `CODEX_HOME` still applies.
