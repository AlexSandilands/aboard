import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  isTaskWindowName,
  type TerminalOpenIn,
  type TerminalSetting,
  type TerminalShell,
  type WindowsTerminalProfile,
} from "@repo/contracts";

// Opening a command in a new terminal window, per platform and per shell. Everything here is pure except the
// `TerminalHost` it is given, so the argv for every shell is unit-tested (see docs/decisions/0009-board-starts-local-processes.md).

/** What the launcher needs from the machine. */
export interface TerminalHost {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  readFile(path: string): string | null;
  /** The full path of an executable on PATH, or null. */
  which(name: string): string | null;
}

/** A process to start: `file` with `args`, in `cwd`. Arguments are passed as an array, never through a shell. */
export interface LaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  /** Pass args to Windows as written: only for cmd.exe, whose quoting rules aren't the C runtime's. */
  verbatim?: boolean;
}

// ── Quoting ──────────────────────────────────────────────────────────────

/** POSIX sh: single quotes, with `'` written as `'\''`. A backslash is an escape there, so it is always quoted. */
export const shQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/**
 * PowerShell: single quotes are literal, with `'` doubled. PowerShell also reads the typographic single quotes
 * (‘ ’ ‚ ‛) as quotes, so they are doubled too. `@` and `,` mean something there, so they are quoted.
 */
export const psQuote = (value: string): string =>
  /^[\w%+=:./\\-]+$/.test(value) ? value : `'${value.replace(/['‘-‛]/g, "$&$&")}'`;

/**
 * cmd.exe: double quotes. A Windows path can't contain `"`, and the only values quoted here are paths, so a value
 * with one is refused rather than escaped (cmd has no reliable escape inside quotes).
 */
export function cmdQuote(value: string): string {
  if (value.includes('"')) throw new Error(`Can't quote ${value} for cmd.exe`);
  return /^[\w@+=:,./\\-]+$/.test(value) ? value : `"${value}"`;
}

/** Shows an argv the way Windows would see it, for previews. Not used to run anything. */
const displayWindows = (argv: readonly string[]): string =>
  argv.map((a) => (a === "" ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");

const displayPosix = (argv: readonly string[]): string => argv.map(shQuote).join(" ");

// ── Commands inside each shell ───────────────────────────────────────────

/** Arguments that make `shell` run `command` and then stay open, so the window doesn't vanish when it exits. */
export function shellArgs(shell: TerminalShell, command: readonly string[]): string[] {
  switch (shell) {
    case "bash":
      return ["-l", "-i", "-c", `${command.map(shQuote).join(" ")}; exec bash`];
    case "sh":
      return ["-c", `${command.map(shQuote).join(" ")}; exec "\${SHELL:-sh}"`];
    case "cmd":
      // A resume command is a CLI name, flags and a UUID, which need no quoting for cmd. Free text (a new
      // session's prompt) has been through textArgument, so it has whitespace and no `"` or `%`: Windows Terminal
      // and consoleLaunch put it in quotes, where cmd reads nothing into it.
      return ["/k", ...command];
    case "powershell":
    case "pwsh":
      return ["-NoExit", "-Command", command.map(psQuote).join(" ")];
  }
}

/** What to paste in a terminal of `shell` to resume by hand: change to the folder, then run the command. */
export function copyCommand(shell: TerminalShell, command: readonly string[], cwd: string): string {
  switch (shell) {
    case "bash":
    case "sh":
      return `cd ${shQuote(cwd)} && ${command.map(shQuote).join(" ")}`;
    case "cmd":
      return `cd /d ${cmdQuote(cwd)} && ${command.map(cmdQuote).join(" ")}`;
    case "powershell":
    case "pwsh":
      return `Set-Location -LiteralPath ${psQuote(cwd)}; ${command.map(psQuote).join(" ")}`;
  }
}

// ── Free text on a command line ──────────────────────────────────────────

/** cmd.exe takes command lines of up to 8,191 characters; this leaves room for what wraps the command. */
const MAX_WINDOWS_COMMAND_LINE = 8000;
const MAX_POSIX_COMMAND_LINE = 100_000;

/**
 * Free text (a new session's first prompt) as it can go on a command line here as one argument, or why it can't.
 * POSIX shells take anything in single quotes. On Windows the text crosses Windows Terminal, which wraps an argument
 * containing spaces in quotes without escaping quotes inside it, and often cmd.exe (a console window, a custom
 * command, an npm `.cmd` shim), which has no escape inside quotes and expands %NAME% even there. So there line breaks
 * become spaces, `"` becomes `'`, a trailing backslash (which would escape the closing quote) is followed by a space,
 * the text always contains a space (so it is always quoted), and a `%` is refused. Control characters are dropped
 * everywhere.
 */
export function textArgument(text: string, platform: NodeJS.Platform): { value: string } | { error: string } {
  // oxlint-disable-next-line no-control-regex -- control characters are what this removes
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  if (platform !== "win32") return { value: clean };
  if (clean.includes("%")) return { error: "it contains %, which Windows command lines can't pass safely" };
  let value = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\t/g, " ")
    .replaceAll('"', "'");
  if (value.endsWith("\\")) value += " ";
  if (!/\s/.test(value)) value += " ";
  return { value };
}

/** Whether a launch fits on this platform's command line; a longer one must be shortened. */
export function fitsCommandLine(spec: LaunchSpec, platform: NodeJS.Platform): boolean {
  const length = [spec.file, ...spec.args].reduce((sum, arg) => sum + arg.length + 3, 0);
  return length <= (platform === "win32" ? MAX_WINDOWS_COMMAND_LINE : MAX_POSIX_COMMAND_LINE);
}

// ── Windows Terminal ─────────────────────────────────────────────────────

/** Strips `//` and `/* *\/` comments and trailing commas, which Windows Terminal's settings.json allows. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface WtRawProfile {
  guid?: unknown;
  name?: unknown;
  commandline?: unknown;
  source?: unknown;
  hidden?: unknown;
}

export interface WtProfile extends WindowsTerminalProfile {
  /** The shell's executable, from the profile's command line, or the usual one for its shell. */
  exe: string | null;
}

export interface WtSettings {
  path: string;
  defaultProfile: string | null;
  /** Visible profiles, the default first. */
  profiles: WtProfile[];
}

/** Windows Terminal's settings.json: the Store build, then Preview, then an unpackaged install. */
export function wtSettingsPaths(env: TerminalHost["env"]): string[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return [
    join(local, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(local, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(local, "Microsoft", "Windows Terminal", "settings.json"),
  ];
}

/** `%SystemRoot%\System32\cmd.exe` → `C:\Windows\System32\cmd.exe`; the first token of a command line. */
function commandlineExe(commandline: string, env: TerminalHost["env"]): string {
  const expanded = commandline.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? (env[key] ?? whole) : whole;
  });
  const trimmed = expanded.trim();
  if (trimmed.startsWith('"'))
    return trimmed.slice(1, trimmed.indexOf('"', 1) > 0 ? trimmed.indexOf('"', 1) : undefined);
  // Windows Terminal writes Git Bash's path unquoted, spaces and all (`C:\Program Files\Git\bin\bash.exe`).
  return /^.*?\.exe(?=\s|$)/i.exec(trimmed)?.[0] ?? trimmed.split(/\s+/)[0]!;
}

/** The shell a profile runs, from its command line or, for generated profiles, its source. */
export function profileShell(
  profile: { commandline?: string | undefined; source?: string | undefined },
  env: TerminalHost["env"],
): { shell: TerminalShell; exe: string } | null {
  if (profile.commandline) {
    const exe = commandlineExe(profile.commandline, env);
    const name = exe.replace(/^.*[\\/]/, "").toLowerCase();
    if (name === "bash.exe" || name === "bash") return { shell: "bash", exe };
    if (name === "cmd.exe" || name === "cmd") return { shell: "cmd", exe };
    if (name === "powershell.exe" || name === "powershell") return { shell: "powershell", exe };
    if (name === "pwsh.exe" || name === "pwsh") return { shell: "pwsh", exe };
    return null;
  }
  if (profile.source === "Windows.Terminal.PowershellCore") return { shell: "pwsh", exe: "pwsh.exe" };
  if (profile.source === "Git") return { shell: "bash", exe: "bash.exe" };
  return null;
}

/** Reads the first Windows Terminal settings.json found. Null when there is none or it can't be parsed. */
export function readWtSettings(host: Pick<TerminalHost, "env" | "readFile">): WtSettings | null {
  for (const path of wtSettingsPaths(host.env)) {
    const text = host.readFile(path);
    if (text === null) continue;
    let json: { defaultProfile?: unknown; profiles?: unknown };
    try {
      json = JSON.parse(stripJsonc(text)) as typeof json;
    } catch {
      return null;
    }
    const list = Array.isArray(json.profiles)
      ? json.profiles
      : ((json.profiles as { list?: unknown } | undefined)?.list ?? []);
    const profiles = (Array.isArray(list) ? (list as WtRawProfile[]) : []).flatMap((p): WtProfile[] => {
      if (typeof p.guid !== "string" || p.hidden === true) return [];
      const shell = profileShell(
        {
          commandline: typeof p.commandline === "string" ? p.commandline : undefined,
          source: typeof p.source === "string" ? p.source : undefined,
        },
        host.env,
      );
      return [
        {
          guid: p.guid,
          name: typeof p.name === "string" ? p.name : p.guid,
          shell: shell?.shell ?? null,
          exe: shell?.exe ?? null,
        },
      ];
    });
    const wanted = typeof json.defaultProfile === "string" ? json.defaultProfile.toLowerCase() : null;
    const def = profiles.find((p) => p.guid.toLowerCase() === wanted) ?? profiles[0] ?? null;
    return {
      path,
      defaultProfile: def?.guid ?? null,
      profiles: def ? [def, ...profiles.filter((p) => p !== def)] : [],
    };
  }
  return null;
}

/**
 * Windows Terminal splits its own command line on `;` (a new tab per part), wherever it appears, quotes included.
 * `\;` passes one through to the shell.
 */
const wtEscape = (arg: string): string => arg.replace(/;/g, "\\;");

/** Where a Windows Terminal tab opens: the setting's choice, or a window of that name (a task's, see taskWindowName). */
export type WtTarget = TerminalOpenIn | { name: string };

/** wt's `-w` value for a target. A name is checked again here, as it reaches wt's command line. */
function wtWindow(target: WtTarget): string {
  if (target === "tab") return "0";
  if (target === "window") return "new";
  if (!isTaskWindowName(target.name)) throw new TerminalUnavailable(`Not a window name: ${target.name}`);
  return target.name;
}

/**
 * A Windows Terminal tab on `profile`, running the command in the profile's shell: in a window of its own, in the
 * most recently used one (`-w 0`, which Windows Terminal turns into a new window when none is open), or in the
 * window of that name (made when there is none).
 */
export function wtLaunch(
  wt: string,
  profile: WtProfile,
  command: readonly string[],
  cwd: string,
  openIn: WtTarget = "tab",
): LaunchSpec {
  // A profile whose shell we can't drive (WSL, Azure Cloud Shell) keeps its look but runs cmd.
  const shell = profile.shell ?? "cmd";
  const exe = profile.shell ? (profile.exe ?? `${shell}.exe`) : "cmd.exe";
  const window = wtWindow(openIn);
  return {
    file: wt,
    args: ["-w", window, "new-tab", "-p", profile.guid, "-d", cwd, exe, ...shellArgs(shell, command)].map(wtEscape),
    cwd,
  };
}

/**
 * Brings the window of that name to the front, on its first tab. Only for a window the board named, and only while
 * a session is known to run in it: for a name with no window, Windows Terminal would open a new one.
 */
export function wtFocus(wt: string, name: string, cwd: string): LaunchSpec {
  return { file: wt, args: ["-w", wtWindow({ name }), "focus-tab", "-t", "0"], cwd };
}

/**
 * A new console window via cmd's `start`, which the window inherits `cwd` from, so no path is on the command line.
 * cmd.exe's own quoting applies, hence verbatim arguments. Every token is a CLI name, flag or UUID, or free text
 * that went through textArgument (no `"` or `%`), so cmdQuote can quote it.
 */
export function consoleLaunch(shell: "cmd" | "powershell", command: readonly string[], cwd: string): LaunchSpec {
  const inner =
    shell === "cmd"
      ? ["cmd.exe", ...shellArgs("cmd", command)]
      : ["powershell.exe", ...shellArgs("powershell", command)];
  const line = inner.map(cmdQuote).join(" ");
  return { file: "cmd.exe", args: ["/d", "/s", "/c", `"start "" ${line}"`], cwd, verbatim: true };
}

// ── Choosing the terminal ────────────────────────────────────────────────

/** How a setting runs here: the process to start, the shell the session lands in, and a printable form. */
export interface ResolvedTerminal {
  /**
   * Builds the process for a command in a folder. `window` names the Windows Terminal window to open it in (made when
   * there is none); other terminals ignore it.
   */
  launch(command: readonly string[], cwd: string, opts?: { window?: string }): LaunchSpec;
  /** Windows Terminal only: brings the window of that name to the front (see wtFocus). */
  focus?: (window: string, cwd: string) => LaunchSpec;
  /** The shell the command runs in, for the copy command. */
  shell: TerminalShell;
  label: string;
}

export class TerminalUnavailable extends Error {}

/** The shell a user on this platform most likely types in, for the copy command when no terminal applies. */
export const defaultShell = (platform: NodeJS.Platform): TerminalShell => (platform === "win32" ? "cmd" : "bash");

/**
 * Linux terminals in the order tried, each with the flag after which the rest of its arguments are the command.
 * xfce4-terminal's `-e` takes one string, so it gets `-x`; x-terminal-emulator is Debian's wrapper, which takes `-e`.
 */
const LINUX_TERMINALS = [
  { name: "x-terminal-emulator", execFlag: "-e" },
  { name: "gnome-terminal", execFlag: "--" },
  { name: "konsole", execFlag: "-e" },
  { name: "xfce4-terminal", execFlag: "-x" },
  { name: "xterm", execFlag: "-e" },
] as const;

/** Resolves the terminal setting on this machine. Throws TerminalUnavailable with a reason when it can't run. */
export function resolveTerminal(
  setting: TerminalSetting,
  host: TerminalHost,
  openIn: TerminalOpenIn = "tab",
): ResolvedTerminal {
  const windows = host.platform === "win32";
  const needWindows = (what: string) => {
    if (!windows) throw new TerminalUnavailable(`${what} is only available on Windows`);
  };

  switch (setting.kind) {
    case "auto": {
      if (windows) {
        const wt = host.which("wt.exe");
        const settings = wt ? readWtSettings(host) : null;
        const profile = settings?.profiles[0];
        if (wt && profile) return wtTerminal(profile, openIn);
        return { launch: (c, cwd) => consoleLaunch("cmd", c, cwd), shell: "cmd", label: "Command Prompt" };
      }
      if (host.platform === "darwin") {
        return {
          shell: "bash",
          label: "Terminal",
          launch: (command, cwd) => {
            const script = `cd ${shQuote(cwd)} && ${command.map(shQuote).join(" ")}`;
            const literal = `"${script.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
            return {
              file: "osascript",
              args: [
                "-e",
                `tell application "Terminal" to do script ${literal}`,
                "-e",
                'tell application "Terminal" to activate',
              ],
              cwd,
            };
          },
        };
      }
      const found = LINUX_TERMINALS.map((t) => ({ ...t, path: host.which(t.name) })).find((t) => t.path);
      if (!found) throw new TerminalUnavailable("No terminal found; choose a custom command in Settings → Terminal");
      return {
        shell: "bash",
        label: found.name,
        launch: (command, cwd) => ({
          file: found.path!,
          // Some terminals hand the window to a server process that doesn't keep our cwd, so the script changes to it.
          args: [
            found.execFlag,
            "bash",
            "-l",
            "-i",
            "-c",
            `cd ${shQuote(cwd)} && ${command.map(shQuote).join(" ")}; exec bash`,
          ],
          cwd,
        }),
      };
    }
    case "windows-terminal": {
      needWindows("Windows Terminal");
      const wt = host.which("wt.exe");
      if (!wt) throw new TerminalUnavailable("Windows Terminal (wt.exe) isn't installed");
      const profile = readWtSettings(host)?.profiles.find(
        (p) => p.guid.toLowerCase() === setting.profile.toLowerCase(),
      );
      if (!profile) throw new TerminalUnavailable("That Windows Terminal profile no longer exists");
      return wtTerminal(profile, openIn);
    }
    case "cmd":
      needWindows("Command Prompt");
      return { launch: (c, cwd) => consoleLaunch("cmd", c, cwd), shell: "cmd", label: "Command Prompt" };
    case "powershell":
      needWindows("Windows PowerShell");
      return {
        launch: (c, cwd) => consoleLaunch("powershell", c, cwd),
        shell: "powershell",
        label: "Windows PowerShell",
      };
    case "custom":
      return customTerminal(setting.template, host);
  }
}

/**
 * wt.exe is an App Execution Alias in WindowsApps: spawning it by full path fails with ENOENT, while spawning it by
 * name works, so PATH is only used to see that it is installed.
 */
function wtTerminal(profile: WtProfile, openIn: TerminalOpenIn): ResolvedTerminal {
  return {
    launch: (command, cwd, opts) =>
      wtLaunch("wt.exe", profile, command, cwd, opts?.window ? { name: opts.window } : openIn),
    focus: (window, cwd) => wtFocus("wt.exe", window, cwd),
    shell: profile.shell ?? "cmd",
    label: `Windows Terminal (${profile.name})`,
  };
}

/**
 * A user-written command line, run by the platform shell: cmd.exe on Windows, sh elsewhere. {cwd} is quoted for that
 * shell; {command} is the command, each token quoted the same way (free text has been through textArgument).
 */
export function customTerminal(template: string, host: Pick<TerminalHost, "platform">): ResolvedTerminal {
  const windows = host.platform === "win32";
  return {
    shell: windows ? "cmd" : "sh",
    label: "Custom command",
    launch: (command, cwd) => {
      // cmd expands %NAME% even inside quotes, which would rewrite the folder before the terminal sees it.
      if (windows && cwd.includes("%"))
        throw new TerminalUnavailable(`Can't pass a folder containing % to cmd: ${cwd}`);
      const line = template
        .replaceAll("{cwd}", windows ? cmdQuote(cwd) : shQuote(cwd))
        .replaceAll("{command}", command.map(windows ? cmdQuote : shQuote).join(" "));
      return windows
        ? { file: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], cwd, verbatim: true }
        : { file: "/bin/sh", args: ["-c", line], cwd };
    },
  };
}

/** A launch as the user would type it, for previews and error messages. */
export function displayLaunch(spec: LaunchSpec, platform: NodeJS.Platform): string {
  const file = spec.file.replace(/^.*[\\/]/, "");
  if (spec.verbatim) return [file, ...spec.args].join(" ");
  return platform === "win32" ? displayWindows([file, ...spec.args]) : displayPosix([file, ...spec.args]);
}

// ── The real host and spawner ────────────────────────────────────────────

/** Looks `name` up on PATH, as a shell would (with PATHEXT on Windows when it has no extension). */
export function whichOnPath(name: string, env: TerminalHost["env"], platform: NodeJS.Platform): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = platform === "win32" && !/\.[a-z]+$/i.test(name) ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

export const systemTerminalHost = (): TerminalHost => ({
  platform: process.platform,
  env: process.env,
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  which: (name) => whichOnPath(name, process.env, process.platform),
});

export type SpawnTerminal = (spec: LaunchSpec) => Promise<void>;

/** Starts the terminal detached and resolves once it has started, or rejects when it couldn't be. */
export const spawnTerminal: SpawnTerminal = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: spec.verbatim ?? false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
