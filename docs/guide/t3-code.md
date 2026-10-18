# T3 Code

The board works with [T3 Code](https://github.com/pingdotgg/t3code) when it's running and detects it
automatically. Everything here is optional.

## Thread links

Agents inside T3 Code attach their thread to the task they're working on. The card (while the thread is
active) and the task panel then get an **Open in T3 Code** button. Choose in Settings whether it opens
the desktop app or your paired browser.

## Import projects

Command palette → _Add project → From T3 Code_. This only reads; the board never touches T3 Code's data
files, and only starts threads through T3 Code's own API when you ask it to.

## Live thread status and new threads

Pair the board with T3 Code to see whether each linked thread is working, waiting for input or done, and
to start new threads from a task:

1. In T3 Code, open **Settings → Connections → Create link** and allow "View environment" and "Operate
   tasks".
2. Paste the pairing link into the board's **Settings → Integrations → T3 Code** within 5 minutes. The board exchanges
   it for a 30-day token.

If you have the `t3` CLI, you can paste a token from it instead:

```sh
t3 auth session issue --scope orchestration:read --scope orchestration:operate --token-only
```

`orchestration:read` alone is enough for thread status. With `orchestration:operate` too, the hand-off
menu gets **New T3 Code thread…**, which opens a new thread for the task; you pick the model, access,
worktree and branch in a dialog. To keep it out of the menu, turn off **Show in hand-off menus** under
**Settings → Integrations → T3 Code**.

More detail: [docs/features/agent-handoff.md](../features/agent-handoff.md).
