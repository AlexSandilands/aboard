<p align="center">
  <img src="apps/web/public/favicons/a-card.svg" alt="Aboard" width="112" />
</p>

<h1 align="center">Aboard</h1>

<p align="center">
  <strong>Mission control for your coding agents.</strong><br>
  A local kanban board where agents log ideas, write plans and report progress over MCP,<br>
  so you can run dozens of streams of work at once without losing track of any of them.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20browser-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Platform: Windows or browser" />
  <img src="https://img.shields.io/badge/MCP-server-8B5CF6?style=flat-square" alt="MCP server" />
  <img src="https://img.shields.io/badge/node-24%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node 24+" />
  <img src="https://img.shields.io/badge/electron-44-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 44" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/typescript-6-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 6" />
</p>

<br>

<p align="center">
  <img src=".github/assets/demo.gif" alt="Agents update the board live: a new idea appears, a step is ticked off, a blocked step shows up under Needs attention, then a task opens with its plan and agent thread" width="900" />
</p>

<br>

## Why

Coding agents made it cheap to start work. Keeping track of it is the hard part: five repos, a dozen
agent threads, PRs waiting on checks, ideas you had halfway through something else. All of that ends
up living in your head.

Aboard moves it onto a board, and the agents keep the board up to date themselves:

- **One glance, every project.** A swimlane per repo, columns from **Ideas** to **Done**. You can see
  what's moving, what's stuck and what's waiting on you.
- **Agents do the bookkeeping.** Over MCP they capture ideas, write a plan before they start, tick off
  steps as they go and leave a handover note when they stop. You don't have to update anything.
- **Pick up anything in seconds.** Every task shows its plan, the step it's on, its PRs, Jira issue and
  agent thread. Resume it yourself, or hand it to a fresh agent with one click.
- **Problems come to you.** Failing checks, requested changes and blocked steps collect under
  **Needs attention**, so you don't have to go looking.
- **Ideas don't get lost.** Anything worth doing later goes into Ideas in one call, and the agent
  carries on with what it was doing.

Everything runs on your machine: a local server and a SQLite file, with no account and no cloud.

## Install

> [!NOTE]
> A Windows installer on [GitHub Releases](https://github.com/example/aboard/releases) is on the
> way. Until then, run it from source as below.

## Run from source

You need [Node 24+](https://nodejs.org) and [pnpm](https://pnpm.io).

```sh
git clone https://github.com/example/aboard.git
cd aboard
pnpm install
```

Then pick one:

```sh
pnpm start              # in the browser: http://127.0.0.1:4317
pnpm desktop:package    # the Windows app: apps/desktop/release/Aboard-Setup-<version>.exe
```

The desktop app keeps the board running in the tray, so agents can reach it with no terminal open.

## Connect an agent

Add the MCP server once for your user (Claude Code shown; [other agents](docs/guide/connect-agents.md)):

```sh
claude mcp add --scope user --transport http aboard http://127.0.0.1:4317/mcp
```

Then teach it the workflow: copy [`skills/aboard`](skills/aboard) to `~/.claude/skills/aboard`, or paste
[`AGENTS-snippet.md`](skills/aboard/AGENTS-snippet.md) into your `AGENTS.md`. Agents identify the project
by their working directory, so there's nothing to set up per repo.

## Learn more

| Guide                                             | What's in it                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| [Using the board](docs/guide/using-the-board.md)  | Plans, closing and deleting tasks, links, labels, layout, shortcuts |
| [Connecting agents](docs/guide/connect-agents.md) | MCP setup for Claude Code, Codex, Copilot and VS Code               |
| [Local review](docs/guide/local-review.md)        | Have agents' work reviewed on the board before they open a PR       |
| [T3 Code](docs/guide/t3-code.md)                  | Thread links, live thread status, starting threads from a task      |
| [Configuration](docs/guide/configuration.md)      | Data folder, ports, access token, the desktop app's tray            |
| [Contributing](CONTRIBUTING.md)                   | Developing, checks, and where the design docs are                   |

<br>

<p align="center">
  <sub>UI components and design tokens adapted from <a href="https://github.com/pingdotgg/t3code">T3 Code</a> under the MIT license. See <a href="NOTICE">NOTICE</a>.</sub>
</p>
