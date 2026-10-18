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

**Settings → Integrations** shows whether Claude Code and Copilot CLI have the server: a green dot means the CLI
runs and an entry with the board's address is registered, under any name.

## Teach it the workflow

The server explains the basics when an agent connects. For the full workflow:

- **Claude Code, Copilot, Codex:** in **Settings → Integrations**, turn on **Board skill** in the agent's
  section. The board installs [`skills/aboard`](../../skills/aboard) into its global skills folder
  (`~/.claude/skills/aboard`, `~/.copilot/skills/aboard` or `~/.codex/skills/aboard`) and rewrites it when an
  update changes it, so agents never follow an old workflow. It's off until you turn it on.
- **Other agents:** paste [`skills/aboard/AGENTS-snippet.md`](../../skills/aboard/AGENTS-snippet.md) into
  your `AGENTS.md` or `CLAUDE.md`. **Copy snippet** in the Codex section copies it and, later, says when it
  changed since you copied it: paste it again then, since tools get renamed and an old copy sends agents to
  tools that no longer exist.

The row shows the installed copy's state: **Up to date**, **Out of date** (rewritten when the board next
starts), or **Edited by you**. The board only rewrites a copy that is still exactly what it wrote; one you
edited stays yours until you choose **Overwrite**, or **Keep mine** to stop syncing it. Turning the switch off
asks whether to delete the installed copy, and it never touches your other skills.

## Projects

Agents identify the project by passing their working directory, so there's nothing to configure per
repo. A folder the board hasn't seen becomes a new project automatically.
