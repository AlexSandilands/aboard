// The settings index: every sub-section and row of the settings page with the words people search for it by, and
// where it lives. Settings search matches over it, and the settings "Ask" (#122) puts it in its prompt, so it stays
// plain data. Sub-sections come from `SETTINGS_GROUPS` and the rows that are generated (notification kinds, model
// tiers) from their contracts; the rest are listed here by hand, which `settingsIndex.logic.test.ts` checks against
// the ids the components render, so a row added without an entry fails a test.
import {
  AUTOPILOT_DIGEST,
  AUTOPILOT_FIX_PRS,
  AUTOPILOT_REVIEW_PRS,
  AUTOPILOT_START_PLANNED,
  BRAND,
  DEFAULT_KEYBINDINGS,
  KeybindingCommand,
  MODEL_TIERS,
  NOTIFICATION_KINDS,
  OPERATIONS,
} from "@repo/contracts";
import { OPERATION_DESCRIPTIONS, OPERATION_GROUPS, operationTarget } from "~/components/models/operations.logic";
import { keybindingSectionId } from "./keybindings.logic";
import { SETTINGS_GROUPS, sectionOf, type SettingsGroupId } from "./settingsNav.logic";

export interface SettingsIndexEntry {
  /** The settings target: what `useOpenSettings` takes, and the element id on the page. */
  id: string;
  /** A sidebar sub-section, a titled card inside one, or a single setting. */
  kind: "section" | "card" | "row";
  title: string;
  description: string;
  /** Extra words that find it: other names for the thing, or for what it does. */
  keywords: ReadonlyArray<string>;
  group: SettingsGroupId;
  groupLabel: string;
  /** The sidebar sub-section it sits in. */
  sectionId: string;
  sectionLabel: string;
  /** The folded section that has to be opened to see it, when it is inside one. */
  foldedIn: string | null;
}

type Draft = Pick<SettingsIndexEntry, "id" | "title" | "description" | "keywords"> &
  Partial<Pick<SettingsIndexEntry, "kind" | "foldedIn">>;

const draft = (id: string, title: string, description: string, keywords: ReadonlyArray<string> = []): Draft => ({
  id,
  title,
  description,
  keywords,
});

/**
 * Cards and rows whose ids can't be listed: one per GitHub host `gh` is signed in to, one per custom model and one per
 * ticket system. A row may use one of these prefixes without an entry of its own.
 */
export const DYNAMIC_ROW_PREFIXES: ReadonlyArray<string> = [
  "integrations.github.host-",
  "agents.models.custom.",
  "integrations.tickets.system-",
];

/** Orchestrate's row in the Autopilot list, which opens its detail. */
const ORCHESTRATE_ID = "autopilot.automations.orchestrate";

/** Titles and descriptions of the built-in automations, as the server defines them (a test compares the titles). */
export const AUTOMATION_ENTRIES: ReadonlyArray<{
  key: string;
  title: string;
  description: string;
}> = [
  {
    key: AUTOPILOT_START_PLANNED,
    title: "Start planned tasks",
    description:
      "Starts an agent on each Planned task whose Autopilot flag is On, once it has a plan and nothing blocks it.",
  },
  {
    key: AUTOPILOT_REVIEW_PRS,
    title: "Review PRs",
    description: "Reviews pull requests linked to tasks and posts the review on GitHub as comments.",
  },
  {
    key: AUTOPILOT_FIX_PRS,
    title: "Fix PRs",
    description: "Fixes linked pull requests when checks fail, they conflict, a reviewer asks for changes or comments.",
  },
  {
    key: "auto_archive",
    title: "Auto-archive Done",
    description: "Archives tasks that have been in Done for more than the set number of days, and finished epics.",
  },
  {
    key: AUTOPILOT_DIGEST,
    title: "Digest of what changed",
    description: "Writes a daily digest of what changed on the board, as a plain list or written by an agent.",
  },
];

const MCP = `Register the ${BRAND.id} MCP server.`;
const BOARD_SKILL =
  "Install the board's skills, which teach agents the workflow and how to write custom automations, and keep them updated with the app. A copy you edited is never overwritten without asking.";
const BOARD_SKILL_KEYWORDS = ["install", "sync", "update", "agents", "instructions", "workflow", "automations"];

const WRITTEN: ReadonlyArray<Draft> = [
  // Board › Appearance
  draft(
    "board.appearance.theme",
    "Colors & themes",
    "Follow the system or pick light or dark, and pick a theme: T3 Code, T3 Chat, Grove, Ocean, Ember or Iris, for both appearances or one.",
    ["dark mode", "light mode", "colour", "color", "palette", "theme", "t3 chat", "grove", "ocean", "ember", "iris"],
  ),
  draft(
    "board.appearance.contrast",
    "Contrast",
    "Fades text and borders toward their background below 100%, and strengthens them above it.",
    ["accessibility", "readability", "legibility", "borders"],
  ),
  draft(
    "board.appearance.glass-opacity",
    "Glass opacity",
    "How see-through menus, dialogs and popovers are. 100% makes them solid and turns the blur off.",
    ["transparency", "blur", "translucent", "frosted"],
  ),
  draft(
    "board.appearance.panel-animations",
    "Panel animations",
    "How fast the sidebar opens and closes and the task panel opens. 0 ms turns the animation off.",
    ["motion", "speed", "transition", "duration", "reduced motion"],
  ),
  draft(
    "board.appearance.snapshot-motion",
    "Smooth board motion",
    "Move the board's cards as snapshots while the sidebar or task panel slides, instead of laying the board out every frame.",
    ["motion", "smooth", "frame rate", "refresh rate", "performance", "lag", "jank", "view transition"],
  ),
  draft(
    "board.appearance.interface-font",
    "Interface font",
    "The font and size for everything outside code. The size scales the whole board.",
    ["typography", "typeface", "font size", "text size", "zoom", "scale"],
  ),
  draft(
    "board.appearance.mono-font",
    "Monospace font",
    "The font for code, ids and keyboard shortcuts. Only monospaced fonts are accepted.",
    ["typography", "typeface", "code font", "fixed width"],
  ),
  draft("board.appearance.banner", "Sidebar banner", "The art behind the name in the top-left corner.", [
    "image",
    "logo",
    "header",
  ]),
  draft(
    "board.appearance.priority-lane",
    "Priority lane",
    "Gathers the tasks marked as priority, from every project, in a lane above the projects. Off, they stay in their own lanes.",
    ["star", "urgent", "pinned", "top", "hide"],
  ),
  draft(
    "board.appearance.pinned-lane-height",
    "Pinned lane height",
    "The most of the window the priority lane takes while it is pinned and the board is scrolled. It scrolls inside itself past that.",
    ["pin", "sticky", "priority", "max height", "small", "medium", "large", "size"],
  ),
  draft(
    "board.appearance.scroll-to-task",
    "Scroll to a task when opening it",
    "Opening a task from search, a link or a notification slides the board to its card. Off, only the panel opens.",
    ["jump", "find", "locate", "animation", "motion", "position"],
  ),
  // Board › Notifications
  draft(
    "board.notifications.popups",
    "Pop-ups",
    "An alert when something needs you and the board isn't in front of you. The inbox behind the bell keeps all of them.",
    ["notifications", "alerts", "permission", "desktop"],
  ),
  draft(
    "board.notifications.mute-quiet-hours",
    "Mute during quiet hours",
    "No pop-up while quiet hours are on; they still land in the inbox.",
    ["silence", "do not disturb", "night"],
  ),
  // Board › Data
  draft("board.data.backup", "Backup", "Writes the board as JSON into a git repo and commits when it changes.", [
    "git",
    "export",
    "restore",
    "import",
  ]),
  draft(
    "board.data.backup-setup",
    "Set up backup",
    "Pick a folder, connect a private GitHub repo and take the first backup.",
    ["backup", "github", "setup", "wizard", "repo"],
  ),
  draft(
    "board.data.backup-local-only",
    "Connect GitHub",
    "Shown when backups only commit locally: push them to a private GitHub repo.",
    ["backup", "github", "push", "local only", "remote"],
  ),
  draft(
    "board.data.backup-enabled",
    "Back up to git",
    "Writes the board as JSON into a git repo and commits when it changes. Restore with pnpm backup import.",
    ["backup", "commit", "repo", "restore"],
  ),
  draft("board.data.backup-folder", "Backup folder", "The git repo the board is written into.", [
    "folder",
    "backup",
    "directory",
    "path",
    "repo",
    "clear",
    "unset",
    "remove",
  ]),
  draft(
    "board.data.backup-remote",
    "Backup remote",
    "Optional. Use a private repo: task text stays in its history for good. Pushes use git's own sign-in.",
    ["backup", "push", "origin", "git remote", "private repo"],
  ),
  draft(
    "board.data.machine-name",
    "Machine name",
    "This machine's folder in the backup repo, so several machines can share one repo. Blank uses the host name.",
    ["backup", "machine", "computer", "host name", "folder", "rename"],
  ),
  draft(
    "board.data.backup-interval",
    "Backup interval",
    "How often to check for changes. A run with nothing new makes no commit.",
    ["every", "backup", "frequency", "schedule"],
  ),
  draft("board.data.backup-last", "Last backup", "When the board was last backed up, or the error if it failed.", [
    "backup",
    "status",
    "failed",
  ]),
  draft("board.data.backup-restore", "Restore", "Bring back tasks, or the whole board, from any backup commit.", [
    "backup",
    "restore",
    "undo",
    "deleted",
  ]),
  draft(
    "board.data.backup-move-tasks",
    "Tasks from another machine",
    "Move or copy tasks from another machine that backs up to the same repo.",
    ["move", "copy", "transfer", "machine", "laptop", "desktop", "import"],
  ),
  draft(
    "board.data.backup-reset",
    "Reset backup settings",
    "Forget the folder, remote and machine name and turn backup off, so Set up backup starts over.",
    ["clear", "unset", "remove", "folder", "remote", "start over", "setup"],
  ),
  draft(
    "board.data.archived-projects",
    "Archived projects",
    "Archiving a project hides its lane; it can be restored here.",
    ["restore", "unarchive", "hidden", "lane"],
  ),
  draft("board.data.recently-deleted", "Recently deleted", "Deleted tasks wait here, restorable, until they expire.", [
    "trash",
    "restore",
    "undelete",
    "bin",
    "delete now",
    "purge",
  ]),
  draft(
    "board.data.trash-retention",
    "Keep deleted tasks for",
    "How many days a deleted task stays in the trash before it is removed for good.",
    ["trash", "retention", "days", "expire"],
  ),
  // Tasks › New tasks
  draft(
    "tasks.new-tasks.templates",
    "Templates",
    "Starting points for new tasks: title, description, labels and plan.",
    ["task templates", "bug", "spike", "feature", "placeholders"],
  ),
  draft(
    "tasks.new-tasks.issue-import",
    "Issue import",
    "Paste a ticket key or URL, or a GitHub issue URL, as a new task's title and Claude Code fills it in.",
    ["ticket", "github issue", "import", "claude"],
  ),
  draft(
    "tasks.new-tasks.import-enabled",
    "Fill in imported tasks",
    "Paste a ticket key or URL, or a GitHub issue URL, as a new task's title and Claude Code fills in its description.",
    ["issue import", "ticket", "github issue", "claude", "autofill"],
  ),
  draft(
    "tasks.new-tasks.import-budget",
    "Budget per import",
    "The most one import may spend, in US dollars (claude --max-budget-usd).",
    ["issue import", "cost", "spend", "dollars", "limit"],
  ),
  // Tasks › Planning
  draft(
    "tasks.planning.skill",
    "Planning skill",
    "What a session started with Plan tasks… follows to plan the picked tasks with you.",
    ["plan tasks", "bulk planning", "planner", "prompt", "skill"],
  ),
  // Tasks › Review
  draft(
    "tasks.review.before-pr",
    "Review before the PR",
    "When an agent moves a task to Review, it runs a review loop with a fresh reviewer subagent and fixes what it finds before opening the pull request.",
    ["local review", "auto review", "reviewer", "subagent", "pull request"],
  ),
  draft(
    "tasks.review.skill",
    "Review skill",
    "What the reviewer follows. Skills installed for Claude Code, Copilot or Codex are listed.",
    ["local review", "reviewer", "prompt", "skill"],
  ),
  draft(
    "tasks.review.rounds",
    "Review rounds",
    "The agent stops after this many rounds; open blocking or major findings then flag the card.",
    ["rounds", "local review", "limit", "findings", "max rounds"],
  ),
  draft(
    "tasks.review.board-reviewer",
    "Board reviewer",
    "When no agent reviews a round, the board runs Claude Code headless to review it.",
    ["local review", "headless", "claude", "fallback", "automatic"],
  ),
  draft(
    "tasks.review.budget",
    "Budget per review",
    "The most one board review may spend, in US dollars (claude --max-budget-usd).",
    ["board reviewer", "cost", "spend", "dollars", "limit"],
  ),
  // Autopilot › automations
  draft(
    "autopilot.automations.pause-all",
    "Pause all",
    "Stops every new Autopilot run, whatever the switches say. Runs already going finish. A backup restore never lifts it.",
    ["stop", "halt", "disable", "kill switch", "resume"],
  ),
  draft(
    "autopilot.automations.needs-you",
    "Needs you",
    "Failed runs to retry or dismiss, drafts agents wrote for you to review, and automations missing a tool or variable.",
    ["failed", "retry", "dismiss", "drafts", "review", "attention"],
  ),
  // Autopilot › limits & safety
  draft(
    "autopilot.limits.spending",
    "Spending & timing",
    "How many agent runs Autopilot has open at once, its daily caps on runs and spend, and its quiet hours.",
    ["limits", "caps", "budget", "concurrency"],
  ),
  draft(
    "autopilot.limits.agent-defaults",
    "Defaults for agent runs",
    "Where Autopilot's agents run, their budget and timeout, and T3 Code access. Each automation can override them; models are set in Agents → Operations.",
    ["runner", "budget", "timeout", "headless", "t3 code", "defaults"],
  ),
  draft(
    "autopilot.limits.advanced",
    "Advanced",
    "Preview everything, and how long a finished run's worktree is kept.",
    ["dry run", "preview", "simulate"],
  ),
  draft(
    "autopilot.limits.preview-everything",
    "Preview everything",
    "Every automation records what it would do as a run marked Preview and does nothing. To try one automation, set its own Mode to Preview instead.",
    ["dry run", "preview", "simulate", "test", "watch", "skipped"],
  ),
  draft(
    "autopilot.limits.max-concurrent",
    "Agent runs at once",
    "How many of Autopilot's agent runs can be open at once. Not a limit on your machine. Counts runs Autopilot has open. A T3 thread Autopilot started counts only against Start planned, while it is working; threads you start yourself never count.",
    ["concurrency", "parallel", "limit", "simultaneous"],
  ),
  draft(
    "autopilot.limits.daily-run-cap",
    "Daily run cap",
    "The most agent runs to start per day (local time). Leave empty for no cap.",
    ["limit", "per day", "maximum", "runs"],
  ),
  draft(
    "autopilot.limits.daily-spend-cap",
    "Daily spend cap",
    "No more agent runs start once today's runs have cost this much. Leave empty for no cap.",
    ["budget", "limit", "cost", "dollars", "money"],
  ),
  draft(
    "autopilot.limits.quiet-hours",
    "Quiet hours",
    "No agent runs start in this window (local time, and it may cross midnight). Automations that only change the board still run.",
    ["night", "schedule", "time window", "sleep", "off hours"],
  ),
  draft(
    "autopilot.limits.runner",
    "Where agents run",
    "Auto: a T3 Code thread when T3 Code is connected, else a headless CLI in a worktree. Each automation can override it.",
    ["runner", "headless", "t3 code", "auto", "cli"],
  ),
  draft(
    "autopilot.limits.budget",
    "Budget per headless run",
    "The most a headless Claude Code run may spend. Each automation can override it.",
    ["cost", "dollars", "money", "max budget", "headless"],
  ),
  draft(
    "autopilot.limits.timeout",
    "Timeout per headless run",
    "A headless run still going after this long is stopped. Each automation can override it.",
    ["time limit", "minutes", "stop", "headless"],
  ),
  draft(
    "autopilot.limits.t3-access",
    "T3 Code access",
    "The most access a T3 Code thread Autopilot starts gets, never more than T3 Code's own default.",
    ["runtime mode", "permissions", "approval", "full access"],
  ),
  draft(
    "autopilot.limits.worktree-retention",
    "Worktree retention",
    "How long a finished headless run's worktree is kept when its PR hasn't merged.",
    ["cleanup", "delete", "days", "git worktree", "disk"],
  ),
  draft(
    "autopilot.limits.variables",
    "Variables",
    "Values custom automations read in every project, which a project can override.",
    ["vars", "parameters", "jira key", "project name", "custom automations"],
  ),
  draft(
    "autopilot.limits.variables.list",
    "Automation variables",
    "Values custom automations read as {{vars.name}}, an environment variable or vars on stdin. An automation that needs one doesn't run in a project where it has no value. Not for secrets.",
    ["vars", "parameters", "environment variable", "stdin", "{{vars"],
  ),
  // Providers › T3 Code
  draft(
    "agents.providers.t3-code.status",
    "T3 Code connection",
    "Whether the board can reach the T3 Code app on this machine.",
    ["status", "detected", "running"],
  ),
  draft(
    "agents.providers.t3-code.open-links-in",
    "Open thread links in",
    "Where “Open in T3 Code” goes. The other target stays in the link's menu.",
    ["desktop app", "browser", "deep link"],
  ),
  draft(
    "agents.providers.t3-code.pairing",
    "T3 Code pairing",
    "Optional. Live thread status and starting threads from a task.",
    ["pairing code", "token", "connect", "credentials", "link"],
  ),
  draft(
    "agents.providers.t3-code.agent-threads",
    "Let agents start threads",
    "An agent orchestrating an epic may start its tasks in new T3 threads and message them in your name.",
    ["epic", "orchestrator", "subagent", "worktree", "permission"],
  ),
  draft(
    "agents.providers.t3-code.handoff-menus",
    "Show T3 Code in hand-off menus",
    "Offer “New T3 Code thread…” on tasks and lanes. Off hides it from the board's menus.",
    ["hide", "show", "menu", "hand off", "handoff", "new thread", "new session", "disable", "start"],
  ),
  // Providers › Claude Code
  draft("agents.providers.claude-code.mcp", "Claude Code MCP server", MCP, [
    "add mcp",
    "claude mcp add",
    "register",
    "command",
  ]),
  draft(
    "agents.providers.claude-code.skill",
    "Claude Code board skills",
    `${BOARD_SKILL} In ~/.claude/skills.`,
    BOARD_SKILL_KEYWORDS,
  ),
  draft(
    "agents.providers.claude-code.cli-path",
    "Claude Code CLI path",
    "What the board runs headless for the board reviewer, issue import and the settings Ask, and opens for a new Claude Code session. Leave empty to use claude from your PATH.",
    ["claude path", "executable", "binary", "headless", "session"],
  ),
  draft(
    "agents.providers.claude-code.handoff-menus",
    "Show Claude Code in hand-off menus",
    "Offer “New Claude Code session…” on tasks and lanes. Off hides it from the board's menus.",
    ["hide", "show", "menu", "hand off", "handoff", "new thread", "new session", "disable", "start"],
  ),
  // Providers › GitHub Copilot, Codex
  draft("agents.providers.copilot-cli.mcp", "Copilot CLI MCP server", `${MCP} In ~/.copilot/mcp-config.json.`, [
    "add mcp",
    "github copilot",
    "register",
    "mcp-config",
  ]),
  draft(
    "agents.providers.copilot-cli.vscode",
    "Copilot in VS Code",
    "Add the MCP server to your VS Code user profile, or to .vscode/mcp.json.",
    ["github copilot", "mcp.json", "editor", "servers"],
  ),
  draft("agents.providers.copilot-cli.skill", "Copilot board skills", `${BOARD_SKILL} In ~/.copilot/skills.`, [
    "github copilot",
    ...BOARD_SKILL_KEYWORDS,
  ]),
  draft(
    "agents.providers.copilot-cli.cli-path",
    "Copilot CLI path",
    "What the board opens for a new Copilot CLI session. Leave empty to use copilot from your PATH.",
    ["github copilot", "executable", "binary", "session"],
  ),
  draft(
    "agents.providers.copilot-cli.handoff-menus",
    "Show Copilot CLI in hand-off menus",
    "Offer “New Copilot CLI session…” on tasks and lanes. Off hides it from the board's menus.",
    ["github copilot", "hide", "show", "menu", "hand off", "handoff", "new thread", "new session", "disable", "start"],
  ),
  draft("agents.providers.codex.mcp", "Codex MCP server", MCP, ["openai", "add mcp", "register", "command"]),
  draft(
    "agents.providers.codex.cli-path",
    "Codex CLI path",
    "What the board opens for a new Codex session, and what headless Autopilot runs start for a model that runs on Codex. Leave empty to use codex from your PATH.",
    ["openai", "executable", "binary", "headless", "autopilot", "session"],
  ),
  draft(
    "agents.providers.codex.handoff-menus",
    "Show Codex in hand-off menus",
    "Offer “New Codex session…” on tasks and lanes. Off hides it from the board's menus.",
    ["openai", "hide", "show", "menu", "hand off", "handoff", "new session", "disable", "start"],
  ),
  draft("agents.providers.codex.skill", "Codex board skills", `${BOARD_SKILL} In ~/.codex/skills.`, [
    "openai",
    ...BOARD_SKILL_KEYWORDS,
  ]),
  draft(
    "agents.providers.codex.snippet",
    "AGENTS.md snippet",
    "Copy the board's instructions for your AGENTS.md, for agents that don't read skills. Says when it changed since you copied it.",
    ["agents.md", "instructions", "copy", "other agents", "workflow"],
  ),
  // Integrations › GitHub, Ticket systems
  draft(
    "integrations.github.cli",
    "GitHub CLI",
    "The gh command the board uses to read pull requests, and whether it is signed in.",
    ["gh", "login", "auth", "sign in", "token"],
  ),
  draft(
    "integrations.github.poll-prs",
    "Poll PR status",
    "Refresh state, checks and reviews of GitHub PR links every 2 minutes.",
    ["pull requests", "refresh", "checks", "enterprise", "polling"],
  ),
  draft(
    "integrations.tickets.status",
    "Ticket systems",
    "The issue trackers whose keys and URLs become links, and whose tickets can be imported as tasks.",
    ["jira", "linear", "issue key", "ticket", "link template", "key pattern", "import tools", "preset"],
  ),
  // Integrations › Terminal
  draft(
    "integrations.terminal.terminal",
    "Open sessions in",
    "Where Open in terminal resumes a linked Claude Code or Copilot CLI session.",
    ["terminal", "windows terminal", "powershell", "cmd", "iterm", "resume"],
  ),
  draft(
    "integrations.terminal.open-in",
    "Windows Terminal: open in",
    "Windows Terminal only: a new tab in the window you used last (a new window if none is open), or always a new window. Command Prompt, PowerShell and custom commands always open as their command says.",
    ["open in", "tab", "window", "windows terminal"],
  ),
  draft(
    "integrations.terminal.command",
    "Terminal command",
    "One command line, run by cmd on Windows and sh elsewhere. {cwd} and {command} are filled in.",
    ["command", "custom terminal", "placeholder", "shell"],
  ),
  draft(
    "integrations.terminal.preview",
    "Terminal preview",
    "What opening a session runs, for an example session in your home folder.",
    ["runs", "command line", "example"],
  ),
  // Project
  draft("project.general.name", "Project name", "Shown on the lane header and in the sidebar.", [
    "rename",
    "title",
    "lane",
  ]),
  draft("project.general.icon", "Project icon", "A custom icon, or automatic from the project name.", [
    "icon",
    "favicon",
    "image",
    "logo",
    "avatar",
  ]),
  draft(
    "project.general.folder",
    "Workspace folder",
    "The project's folder on disk, which agents work in and the board finds skills from.",
    ["workspace", "path", "directory", "repo", "root"],
  ),
  draft("project.general.t3-project", "Linked T3 project", "Set when the project is imported from T3 Code.", [
    "t3 code",
    "import",
    "link",
  ]),
  draft(
    "project.plan-skill.skill",
    "Project planning skill",
    "A planning skill for this project's Plan tasks… sessions, instead of the board's.",
    ["plan tasks", "bulk planning", "override", "planner"],
  ),
  draft(
    "project.review-skill.skill",
    "Project review skill",
    "A review skill for this project, instead of the board's.",
    ["local review", "override", "reviewer"],
  ),
  draft(
    "project.models.reviewer",
    "Project reviewer model",
    "The model that reviews this project's tasks, for the reviewer subagent and the board reviewer, instead of the board's.",
    ["local review", "override", "reviewer", "tier", "opus", "subagent", "board reviewer", "model"],
  ),
  draft(
    "project.autopilot.automations",
    "Autopilot overrides",
    "Switch automations on or off for this project, over the board's setting.",
    ["automations", "inherit", "override", "per project"],
  ),
  draft(
    "project.autopilot.variables",
    "Automation variables",
    "This project's overrides of the board's automation variables, which custom automations read.",
    ["vars", "parameters", "jira key", "override", "per project", "custom automations"],
  ),
  draft(
    "project.autopilot.variables.list",
    "Variables for this project",
    "Override the board's variables here, or add ones only this project's automations read. An empty value makes automations that need it skip this project.",
    ["vars", "parameters", "override", "{{vars"],
  ),
  draft("project.recurring.rules", "Recurring tasks", "Rules that create a task from a template on a schedule.", [
    "schedule",
    "repeat",
    "cron",
    "weekly",
    "daily",
    "template",
  ]),
  draft(
    "project.recurring.examples",
    "Recurring task examples",
    "Ready-made recurring rules that add a template for this project.",
    ["suggestions", "schedule", "template"],
  ),
  draft(
    "project.danger-zone.archive",
    "Archive project",
    "Hides the lane and its tasks. Restore it any time from Board settings.",
    ["hide", "remove", "restore"],
  ),
  draft("project.danger-zone.delete", "Delete project", "Permanently deletes the project and all of its tasks.", [
    "remove",
    "destroy",
    "erase",
  ]),
];

/** Rows made from lists in the contracts, so a new notification kind or model tier is found without an entry here. */
function generated(): Draft[] {
  return [
    ...NOTIFICATION_KINDS.map(({ kind, label, description }) =>
      draft(`board.notifications.kind-${kind}`, label, description, ["pop-up", "notification", "alert"]),
    ),
    ...KeybindingCommand.options.map((command) =>
      draft(
        `${keybindingSectionId(DEFAULT_KEYBINDINGS[command].group)}.${command}`,
        DEFAULT_KEYBINDINGS[command].title,
        `The shortcut for this, and when it applies. Default ${DEFAULT_KEYBINDINGS[command].key}.`,
        ["keybinding", "shortcut", "hotkey", "key", "rebind", "when"],
      ),
    ),
    draft(
      "agents.models.tiers.list",
      "Tiers",
      "What light, standard and deep mean for you: a description, and the model each provider starts a session on.",
      [
        "model tiers",
        "light",
        "standard",
        "deep",
        "suggested model",
        "claude",
        "effort",
        "rescan",
        "model list",
        "reasoning effort",
        "preferred provider",
      ],
    ),
    draft(
      "agents.models.custom.list",
      "Custom models",
      "Named models beyond the tiers, each with the task labels that pick it and the models each provider starts on.",
      ["custom model", "profile", "label", "codex", "override", "model per label", "automation model"],
    ),
    ...MODEL_TIERS.map(({ value, label, description }) =>
      draft(`agents.models.tiers.${value}`, `${label} model`, description, [
        "model tier",
        "suggested model",
        "t3 code model",
        "claude code model",
        "copilot model",
        "--model",
        "--effort",
        "session model",
        "effort",
        "preferred",
      ]),
    ),
    ...OPERATION_GROUPS.map((group) =>
      draft(
        `agents.operations.${group.id}`,
        `${group.title} models`,
        `The model each of these runs on: ${group.operations.map((op) => OPERATIONS[op].label).join(", ")}.`,
        ["operation", "model", "inherit", "tier"],
      ),
    ),
    ...OPERATION_GROUPS.flatMap((group) =>
      group.operations.map((op) =>
        draft(operationTarget(op), `${OPERATIONS[op].label} model`, OPERATION_DESCRIPTIONS[op], [
          "model",
          "operation",
          "inherit",
          "tier",
          "custom model",
          "provider",
          "effort",
          "resolves to",
          group.title.toLowerCase(),
        ]),
      ),
    ),
    ...AUTOMATION_ENTRIES.map(({ key, title, description }) =>
      draft(`autopilot.automations.${key}`, title, description, [
        "automation",
        "autopilot",
        "switch",
        "inherit",
        "on",
        "off",
      ]),
    ),
    draft(
      ORCHESTRATE_ID,
      "Orchestrate",
      "Every few minutes, an agent looks over the project's work: nudges stalled threads, retries failed runs, merges ready tasks flagged for auto-merge, and flags what needs you.",
      ["automation", "autopilot", "switch", "babysit", "next check", "run now", "run history", "handover"],
    ),
    draft(
      "board.appearance.autopilot-countdown",
      "Autopilot countdown on lanes",
      "The lane's Autopilot pill counts down to Orchestrate's next check (Autopilot · 12m) while it is on in the project.",
      ["autopilot", "timer", "next run", "pill", "clock", "orchestrate"],
    ),
  ];
}

function resolve(entry: Draft): SettingsIndexEntry {
  const section = sectionOf(entry.id);
  if (!section) throw new Error(`Settings index: ${entry.id} is not under a sub-section`);
  const group = SETTINGS_GROUPS.find((g) => g.sections.includes(section))!;
  return {
    kind: "row",
    foldedIn: null,
    ...entry,
    group: group.id,
    groupLabel: group.label,
    sectionId: section.id,
    sectionLabel: section.label,
  };
}

// Cards that name a thing the user would call a section: the entry says "card" so a row of the same name sorts first.
const CARD_IDS: ReadonlySet<string> = new Set([
  ORCHESTRATE_ID,
  "autopilot.limits.spending",
  "autopilot.limits.agent-defaults",
  "autopilot.limits.advanced",
  "board.data.backup",
  "board.data.archived-projects",
  "board.data.recently-deleted",
  "tasks.new-tasks.templates",
  "tasks.new-tasks.issue-import",
  "agents.models.tiers.list",
  "agents.models.custom.list",
  ...OPERATION_GROUPS.map((group) => `agents.operations.${group.id}`),
  "project.autopilot.automations",
  "project.autopilot.variables",
  "autopilot.limits.variables",
  "project.recurring.rules",
  "project.recurring.examples",
]);

/** Every sub-section, card and row of the settings page, in page order. */
export function settingsIndex(): SettingsIndexEntry[] {
  const sections: SettingsIndexEntry[] = SETTINGS_GROUPS.flatMap((group) =>
    group.sections.map((section) => ({
      id: section.id,
      kind: "section" as const,
      title: section.label,
      description: `${group.label} settings`,
      keywords: section.keywords,
      group: group.id,
      groupLabel: group.label,
      sectionId: section.id,
      sectionLabel: section.label,
      foldedIn: null,
    })),
  );
  const rows = [...WRITTEN, ...generated()].map((entry) =>
    resolve(CARD_IDS.has(entry.id) ? { ...entry, kind: "card" } : entry),
  );
  const order = new Map(SETTINGS_GROUPS.flatMap((g) => g.sections).map((s, i) => [s.id, i] as const));
  // A stable sort: within a sub-section, the section itself first, then its entries as written above.
  return [...sections, ...rows].sort(
    (a, b) => order.get(a.sectionId)! - order.get(b.sectionId)! || kindRank(a) - kindRank(b),
  );
}

const kindRank = (entry: SettingsIndexEntry) => (entry.kind === "section" ? 0 : 1);

/** "Group › Sub-section": where an entry is, as shown under its title. */
export function settingsLocation(entry: SettingsIndexEntry): string {
  // A sub-section named like its group (Autopilot's own) adds nothing.
  if (entry.kind === "section" || entry.sectionLabel === entry.groupLabel) return entry.groupLabel;
  return `${entry.groupLabel} › ${entry.sectionLabel}`;
}
