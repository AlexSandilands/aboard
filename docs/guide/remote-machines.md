# Connecting another machine

The board can connect to another computer, such as a server or a second desktop, and keep a small background
program on it called the **runner**. The runner is what runs a task's agents on that machine. You manage machines in
**Settings → Integrations → Machines**.

The other machine needs Linux (x64 or arm64) or macOS (Apple silicon), with `curl` and `tar`. Nothing else has to
be installed first: the runner brings its own Node.

## Add a machine over SSH

This is the usual way. The board logs in over SSH, installs the runner, starts it as a background service and pairs
with it. Nothing is done by hand on the machine.

1. Make sure `ssh <the machine>` works from this computer **without asking for a password**, and that you have
   connected to it once before so its host key is known. The board uses your own `ssh`, with your keys, agent and
   `~/.ssh/config`.
2. Click **Add machine** and enter the SSH destination: a host, `user@host`, or a name from your `~/.ssh/config`.
3. Optionally tick **Also reach it at its Tailscale address**, give it a name and a prefix, then click
   **Install and connect**.

The install appears in the list with its steps. When it finishes, the machine takes its place.

If it fails, the row says why and what to do. The two common ones:

| It says                                         | Do this                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| SSH couldn't log in without asking for a password | Set up key login (`ssh-copy-id <the machine>`), or unlock your key in the SSH agent |
| This machine has never connected to it          | Run `ssh <the machine>` once in a terminal and accept its key        |

## Add a machine with a pairing code

Use this for a machine this computer can't SSH to but can reach over [Tailscale](https://tailscale.com).

1. Click **Add machine**, choose **With a pairing code**, and copy the command it shows.
2. Run that command on the other machine. It installs the runner and prints an address and a pairing code. The
   code works once, within 10 minutes.
3. Enter the address and the code, then click **Connect**.

## What a machine's row shows

Each machine is one line: a coloured dot, its name and prefix, how it is connected, and its version. Click it to
open it. A machine that needs something from you opens by itself.

| The row says       | What it means                                                                          |
| ------------------ | -------------------------------------------------------------------------------------- |
| Connected          | The board can talk to it. It also says which route is in use and how many runs are going |
| Can't be reached   | No route works right now. The board keeps trying, and **Try now** tries at once. The machine carries on with its tasks meanwhile |
| Needs updating     | It runs a version the board can't talk to. Nothing is exchanged until it has updated   |
| Not paired         | It no longer accepts this board. Run `aboard-server pair` on it and enter the new code |

### Logins

Agents on the other machine use **that machine's** logins, not this one's. The board checks four and shows what is
missing, with the command to run there:

- `claude` and `codex`, the agent CLIs
- `gh`, for pull requests
- `git push`, which needs a credential helper (`gh auth setup-git`) or an SSH key on GitHub

Log in on the machine yourself; the board checks again within a minute.

### Routes

A route is a way to reach the machine: an SSH tunnel, or its own address (a Tailscale address or name, or an
`https` URL). A machine can have several. The board tries them in the order listed, uses the first that works,
falls to the next when one stops working, and moves back when the better one returns.

Use the arrows to reorder them, **Add route** to add an address, and the cross to remove one.

### Version and updates

The board keeps each machine on its own version. When the board is updated, it asks the machine to update too, and
the machine does so once its runs have finished. **Update now** doesn't wait, which ends the runs in flight.

- If an update fails, the machine stays on the version it had, the row says why, and **Try again** asks once more.
- A machine that is _newer_ than the board is left alone. Update the board instead.
- A runner you installed some other way than the two above can't update itself. Run the install command on it again.

### Name and prefix

The name is yours to change. The prefix is one to three letters or digits, suggested from the name. It numbers the
tasks made on that machine while the board can't be reached, like `#E7`, so each machine has its own, and it can't
be changed once a task carries it.

## Tasks a machine holds

A task handed to a machine is worked on there, and the board follows along. Its card and its panel say where it
is: **On engine**.

- **What the machine does shows up on the board** as it happens. If the board was closed or the machine couldn't be
  reached, it catches up when they are connected again, in the order things happened there.
- **You can still change the task on the board.** The change shows at once and is passed to the machine. While the
  machine can't be reached the badge counts what is waiting, **On engine · 2 waiting**, and those changes are
  applied when it is back, after whatever happened there meanwhile. A change the machine can't apply any more (you
  checked off a step the agent had deleted) is taken back, and the task's activity says so.
- **Autopilot's runs for the task happen on the machine**: the agent works in a worktree there, from what is on
  GitHub, with the machine's own logins. Push the task's branch before you hand it over; the board tells you when a
  branch of the task has commits that aren't pushed, since the machine can't see them. A run there is always
  headless, even where an automation is set to T3 Code.
- **Reviews happen there too.** Review rounds open and the board's reviewer runs on the machine, by your review
  settings; the findings show in the task's panel as usual, and Run review or resolving a finding on the board
  reaches the machine.
- **A custom automation's command or script** for the task runs on the machine, in its copy of the project, as the
  user the runner runs as. The run says "on engine".
- **Sessions and tokens** of work on the machine show on the task: a session's status, its tokens (marked "on
  engine" in Usage) and, for agents, its transcript.
- **New Claude Code, Codex or Copilot CLI sessions** from the hand-off menu run on the machine, and so does **Open in
  terminal** for a session there, Autopilot's included. Your terminal connects with `ssh` and the session runs in
  `tmux` on the machine, so it keeps going when you close the terminal; opening it again picks it up where it is. This
  needs an SSH route to the machine (or Tailscale, where `ssh <its tailnet name>` works for you), key login without
  a password prompt, and `tmux` and the CLI installed there. The board tells you which one is missing. Pasted images
  can't go with such a session yet.
- **T3 Code threads** for the task start in the machine's own T3 Code, and open in your T3 Code app when that
  machine is connected to it. Set up T3 Code and its token on the machine first, as on the board
  ([T3 Code](t3-code.md)).
- **Some things wait until the task is back on the board**: archiving it, deleting it, moving it to another
  project, and moving it to another board.
- **A task made on the machine while the board can't be reached** gets the machine's prefix in its number, like
  `#E7`, and keeps it. Use it like any other number: `#E7` finds the task in search, and is a link in notes.

There is no button yet for handing a task to a machine or taking it back; that comes with choosing the machine a
task runs on. Until then it is done through the board's API:

```sh
curl -X POST http://127.0.0.1:4317/api/tasks/42/hold -H 'content-type: application/json' -d '{"machineId": "<the machine's id>"}'
curl -X DELETE http://127.0.0.1:4317/api/tasks/42/hold
```

`GET /api/machines` lists the machines with their ids. Taking a task back needs the machine to be reachable, so
its last changes come with it; `-d '{"force": true}'` takes it back without the machine and loses what it changed
since the board last heard from it.

## Removing a machine

Open the machine and click **Remove machine…**. The board unpairs from it and forgets it. Tasks it held come back
to the board as the board last saw them. The runner stays
installed on the machine; to remove that too, run this there:

```sh
aboard-server service uninstall
```

## Good to know

- The list of machines and their routes belongs to this computer. It isn't part of a backup.
- On macOS the runner runs while you are logged in at the Mac's desktop and stops when you log out.
- A board run from source (not an installed release) can't install over SSH, because there is no release of its
  version to download. Pair with a runner you started yourself instead.

How it works underneath is in [the feature doc](../features/remote-machines.md).
