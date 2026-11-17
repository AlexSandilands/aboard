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
- A machine that [runs tasks inside its own app](#let-this-machine-run-another-boards-tasks) updates when that app
  does. If it falls behind, the row says so: update the app on that machine.

### Name and prefix

The name is yours to change. The prefix is one to three letters or digits, suggested from the name. It numbers the
tasks made on that machine while the board can't be reached, like `#E7`, so each machine has its own, and it can't
be changed once a task carries it.

## Choosing where a task runs

Once a machine is connected, a task that hasn't started can be set to run on it:

- **In the task's panel**, the chip beside its status reads **Run on this machine**. Click it and pick a machine,
  this machine, or **Project default**.
- **In the hand-off window** (Start in T3 Code, New Claude Code session), the same choice is in the strip under the
  message box. It saves onto the task.
- **For a whole project**, Settings › Projects › General › **Runs on** sets where its tasks run unless a task picks
  another machine.

The choice is shown only for a project with a folder, and only while the task is in Backlog or Planned. A task set to
run on a machine shows the machine's letter in front of its number on the card, outlined: **E**182 starts on the
machine whose prefix is E.

**Autopilot starts it there.** When Start planned tasks starts the task, it hands it to the machine first, and the
work happens there. A thread or a session from the hand-off window would run on this machine, so the window won't
start the work of a task set to another machine: pick **This machine** in its strip to start it here instead. Planning
it from the window (Plan with me) is fine, since that doesn't start the task. If the
machine can't be reached or can't clone the repository when Autopilot starts the task, the run fails with the reason
and nothing starts here.

**Once a task has started it stays where it started.** A task that started here stays here; one that started on a
machine stays there until you pull it back.

## Tasks a machine holds

A task handed to a machine is worked on there, and the board follows along. Its card's number carries the machine's
letter (**E**182), and its panel says where it is: **On engine**.

- **What the machine does shows up on the board** as it happens. If the board was closed or the machine couldn't be
  reached, it catches up when they are connected again, in the order things happened there.
- **You can still change the task on the board.** The change shows at once and is passed to the machine. While the
  machine can't be reached the panel counts what is waiting, **On engine · 2 waiting**, marks the step you changed
  with a clock and the activity line with "waiting for engine", and the card's letter gets an amber dot. Those changes
  are applied when it is back, after whatever happened there meanwhile. A change the machine can't apply any more (you
  checked off a step the agent had deleted) is taken back, and the task's activity says so.
- **Autopilot runs on the machine, by itself.** The machine runs your Autopilot automations for the tasks it holds,
  with the switches you set on the board, even while this computer is off: it starts a flagged task once its
  blockers are done, then reviews, fixes and merges its PR. Its runs show here with **on engine** once the board hears
  from it, and so do its notifications. The agent works in a worktree there, from what is on GitHub, with the
  machine's own logins. Push the task's branch before you hand it over; the board tells you when a branch of the task
  has commits that aren't pushed, since the machine can't see them. A run there is always headless, even where an
  automation is set to T3 Code.
- **To keep a chain going while this computer is off**, hand over the tasks of the chain that should run there. A
  task the board keeps waits for the board.
- **Each machine has its own limits.** In **Settings → Autopilot → Limits & safety**, pick the machine under
  **Limits for** to set how many runs it may have at once, its daily caps and its quiet hours. Until you do, it goes
  by this board's. **Pause all** reaches every machine; while one can't be reached, the Autopilot page and the
  header say it hasn't got it yet.
- **A scheduled automation can run on a machine** too: open it in Settings → Autopilot and pick the machine under
  **Runs on**. It then runs there whether or not this computer is on.
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
  a password prompt, and `tmux` and the CLI installed there. The board tells you which one is missing, and offers a
  T3 Code thread on the machine instead (or, when its T3 Code isn't connected yet, takes you to connect it). Pasted
  images can't go with such a session yet.
- **T3 Code threads** for the task start in the machine's own T3 Code, and open in your T3 Code app when that
  machine is connected to it. Run T3 Code on the machine, then connect it from **Settings → Integrations →
  Machines**: open the machine, and under **T3 Code on the machine** paste a pairing link made in T3 Code there under
  Settings → Connections (allow "Operate tasks", or threads can't be started). A machine that runs the board app
  itself uses that app's T3 Code connection: connect it there.
- **Some things wait until the task is back on the board**: archiving it, deleting it, moving it to another
  project, and moving it to another board.
- **A task made on the machine while the board can't be reached** gets the machine's prefix in its number, like
  `#E7`, and keeps it. Use it like any other number: `#E7` finds the task in search, and is a link in notes.

**When the machine can't be reached**, the chip reads **engine · offline**, the card's letter is greyed and struck
through, and the panel says since when, with **Try now**. The agent on the machine carries on meanwhile.

### Pulling a task back

Click **On engine** in the task's panel and choose **Pull back to this machine…**, then **Pull back**. The machine gives
the task back with everything it did, this machine fetches the task's branch, and its runs, reviews and sessions
happen here from then on. While Autopilot is running something for the task on the machine, Pull back waits: the
popover says so.

Pulling back needs the machine, so its last changes come with the task. While it can't be reached the popover also
offers **Take back without engine…**, which brings the task back at once and loses what the machine did since the
board last heard from it (commits it pushed are kept).

## Let this machine run another board's tasks

A computer with its own board, a laptop say, can also be a machine another board runs tasks on, without installing
anything else. Its own board and the other board's tasks stay apart: they never appear on its board.

1. On this computer, open **Settings → Integrations → Machines** and switch on **Let other machines run tasks here**
   under **This machine**. In the desktop app, the tray's **Run tasks for another board…** opens it.
2. If the other board reaches this computer over Tailscale, also switch on **Reachable over Tailscale**. Over SSH,
   leave it off.
3. Click **Make pairing code**. On the other board, choose **Add machine → By pairing code** and enter the address
   and the code shown here.

Once paired, the row says which board it works for and how many of its tasks it holds. **Unpair** ends it; the
tasks it holds stay on this computer until that board takes them back. It works for one board at a time, and can't
pair with its own.

Agents on this computer use the same board address for both boards' tasks. The board passes on a call about the
other board's task by itself. If both boards have a task with the same number, the call is refused and both tasks'
ids are listed: the agent calls again with the one it means.

## Removing a machine

Open the machine and click **Remove machine…**. The board unpairs from it and forgets it. Tasks it held come back
to the board as the board last saw them. The runner stays
installed on the machine; to remove that too, run this there:

```sh
aboard-server service uninstall
```

## Good to know

- The list of machines and their routes belongs to this computer. It isn't part of a backup.
- The runner a board lets other machines use is part of that app: it stops when the app quits, and updates with it.
- On macOS the runner runs while you are logged in at the Mac's desktop and stops when you log out.
- A board run from source (not an installed release) can't install over SSH, because there is no release of its
  version to download. Pair with a runner you started yourself instead.

How it works underneath is in [the feature doc](../features/remote-machines.md).
