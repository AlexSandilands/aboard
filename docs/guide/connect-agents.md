# Connecting agents

The board's MCP endpoint is `http://127.0.0.1:4317/mcp`. Any agent that speaks MCP over HTTP can use it.

## Add the server

Each of these registers the server for your user, so every repo you open can use it:

```sh
claude mcp add --scope user --transport http aboard http://127.0.0.1:4317/mcp      # Claude Code
codex mcp add aboard --url http://127.0.0.1:4317/mcp                                # Codex
copilot mcp add --transport http aboard http://127.0.0.1:4317/mcp                   # GitHub Copilot CLI
code --add-mcp '{"name":"aboard","type":"http","url":"http://127.0.0.1:4317/mcp"}'  # GitHub Copilot in VS Code
```

To share it with a single repo instead, VS Code also reads `.vscode/mcp.json` (note the `servers` key):

```json
{ "servers": { "aboard": { "type": "http", "url": "http://127.0.0.1:4317/mcp" } } }
```

If you've set an [access token](configuration.md#access-token), the agent must send it as a bearer
token.

## Teach it the workflow

The server explains the basics when an agent connects. For the full workflow:

- **Claude Code:** copy [`skills/aboard`](../../skills/aboard) to `~/.claude/skills/aboard`.
- **Other agents:** paste [`skills/aboard/AGENTS-snippet.md`](../../skills/aboard/AGENTS-snippet.md) into
  your `AGENTS.md` or `CLAUDE.md`.

## Projects

Agents identify the project by passing their working directory, so there's nothing to configure per
repo. A folder the board hasn't seen becomes a new project automatically.
