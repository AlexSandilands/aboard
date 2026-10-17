import { describe, expect, it } from "vitest";
import {
  cmdQuote,
  consoleLaunch,
  copyCommand,
  customTerminal,
  displayLaunch,
  profileShell,
  psQuote,
  readWtSettings,
  resolveTerminal,
  shellArgs,
  shQuote,
  stripJsonc,
  wtLaunch,
  type ResolvedTerminal,
  type TerminalHost,
  type WtProfile,
} from "./terminal.ts";

const ID = "b76a4a91-3196-48df-a421-9a32d5ac9978";
const RESUME = ["claude", "--resume", ID];
const COPILOT = ["copilot", `--resume=${ID}`];

describe("quoting", () => {
  it.each([
    ["/home/me/repo", "/home/me/repo"],
    ["C:\\Code\\repo", "'C:\\Code\\repo'"],
    ["/home/me/my repo", "'/home/me/my repo'"],
    ["it's", "'it'\\''s'"],
    ["$(rm -rf ~)", "'$(rm -rf ~)'"],
    ["a;b", "'a;b'"],
    ["", "''"],
  ])("sh %j → %s", (value, expected) => expect(shQuote(value)).toBe(expected));

  it.each([
    ["C:\\Code\\repo", "C:\\Code\\repo"],
    ["C:\\My Code", "'C:\\My Code'"],
    ["O'Brien", "'O''Brien'"],
    ["$env:USERPROFILE", "'$env:USERPROFILE'"],
    ["@splat", "'@splat'"],
    ["a,b", "'a,b'"],
    [`--resume=${ID}`, `--resume=${ID}`],
  ])("PowerShell %j → %s", (value, expected) => expect(psQuote(value)).toBe(expected));

  it("cmd quotes paths with spaces and refuses a double quote", () => {
    expect(cmdQuote("C:\\Code")).toBe("C:\\Code");
    expect(cmdQuote("C:\\My Code & co")).toBe('"C:\\My Code & co"');
    expect(() => cmdQuote('C:\\a"b')).toThrow(/Can't quote/);
  });
});

describe("shellArgs", () => {
  it("keeps each shell open after the command exits", () => {
    expect(shellArgs("bash", RESUME)).toEqual(["-l", "-i", "-c", `claude --resume ${ID}; exec bash`]);
    expect(shellArgs("cmd", RESUME)).toEqual(["/k", "claude", "--resume", ID]);
    expect(shellArgs("powershell", COPILOT)).toEqual(["-NoExit", "-Command", `copilot --resume=${ID}`]);
    expect(shellArgs("pwsh", RESUME)).toEqual(["-NoExit", "-Command", `claude --resume ${ID}`]);
    expect(shellArgs("sh", RESUME)).toEqual(["-c", `claude --resume ${ID}; exec "\${SHELL:-sh}"`]);
  });
});

describe("copyCommand", () => {
  it("changes to the folder first, quoted for each shell", () => {
    expect(copyCommand("bash", RESUME, "C:\\My Code")).toBe(`cd 'C:\\My Code' && claude --resume ${ID}`);
    expect(copyCommand("cmd", RESUME, "C:\\My Code")).toBe(`cd /d "C:\\My Code" && claude --resume ${ID}`);
    expect(copyCommand("powershell", COPILOT, "C:\\Bob's")).toBe(
      `Set-Location -LiteralPath 'C:\\Bob''s'; copilot --resume=${ID}`,
    );
    expect(copyCommand("sh", RESUME, "/srv/x")).toBe(`cd /srv/x && claude --resume ${ID}`);
  });
});

describe("Windows Terminal settings", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", SystemRoot: "C:\\Windows" };
  const STABLE = "Microsoft.WindowsTerminal_8wekyb3d8bbwe";
  const host = (files: Record<string, string>): Pick<TerminalHost, "env" | "readFile"> => ({
    env,
    readFile: (path) => Object.entries(files).find(([key]) => path.includes(key))?.[1] ?? null,
  });

  it("strips comments and trailing commas but not // inside strings", () => {
    const text = `{
      // the default
      "defaultProfile": "{a}", /* block
      comment */
      "url": "https://x//y",
      "list": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonc(text))).toEqual({ defaultProfile: "{a}", url: "https://x//y", list: [1, 2] });
  });

  it("puts the default profile first and maps each profile's shell", () => {
    const settings = readWtSettings(
      host({
        [STABLE]: `{
          "defaultProfile": "{5297A0AD-git}",
          "profiles": {
            "defaults": {},
            "list": [
              { "guid": "{ps}", "name": "Windows PowerShell", "commandline": "%SystemRoot%\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" },
              { "guid": "{cmd}", "name": "Command Prompt", "commandline": "%SystemRoot%\\\\System32\\\\cmd.exe" },
              { "guid": "{hidden}", "name": "Old", "hidden": true },
              { "guid": "{wsl}", "name": "Ubuntu", "source": "Windows.Terminal.Wsl" },
              { "guid": "{pwsh}", "name": "PowerShell", "source": "Windows.Terminal.PowershellCore" },
              { "guid": "{5297a0ad-git}", "name": "Git Bash", "commandline": "\\"C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe\\" -i -l" },
            ],
          },
        }`,
      }),
    );
    expect(settings?.path).toContain(STABLE);
    expect(settings?.defaultProfile).toBe("{5297a0ad-git}");
    expect(settings?.profiles.map((p) => [p.name, p.shell, p.exe])).toEqual([
      ["Git Bash", "bash", "C:\\Program Files\\Git\\bin\\bash.exe"],
      ["Windows PowerShell", "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
      ["Command Prompt", "cmd", "C:\\Windows\\System32\\cmd.exe"],
      ["Ubuntu", null, null],
      ["PowerShell", "pwsh", "pwsh.exe"],
    ]);
  });

  it("reads Preview's or an unpackaged install's settings when the Store build has none", () => {
    const list = `{"profiles": [{"guid": "{c}", "name": "cmd", "commandline": "cmd.exe"}]}`;
    expect(readWtSettings(host({ WindowsTerminalPreview_: list }))?.path).toContain("Preview");
    expect(readWtSettings(host({ "Windows Terminal": list }))?.defaultProfile).toBe("{c}");
    expect(readWtSettings(host({}))).toBeNull();
    expect(readWtSettings(host({ [STABLE]: "{ nope" }))).toBeNull();
  });

  it("knows the common shells by executable", () => {
    expect(profileShell({ commandline: "pwsh.exe -NoLogo" }, env)).toEqual({ shell: "pwsh", exe: "pwsh.exe" });
    expect(profileShell({ commandline: "wsl.exe -d Ubuntu" }, env)).toBeNull();
    expect(profileShell({ source: "Windows.Terminal.Azure" }, env)).toBeNull();
  });

  it("reads an unquoted path with spaces, as Windows Terminal writes Git Bash's", () => {
    expect(profileShell({ commandline: "C:\\Program Files\\Git\\bin\\bash.exe" }, env)).toEqual({
      shell: "bash",
      exe: "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(profileShell({ commandline: "C:\\Program Files\\Git\\bin\\bash.exe --login -i" }, env)?.exe).toBe(
      "C:\\Program Files\\Git\\bin\\bash.exe",
    );
  });
});

describe("launching", () => {
  const bash: WtProfile = { guid: "{git}", name: "Git Bash", shell: "bash", exe: "C:\\Git\\bin\\bash.exe" };

  it("opens a Windows Terminal tab in the last window, escaping ; so it reaches the shell", () => {
    expect(wtLaunch("wt.exe", bash, RESUME, "C:\\a;b")).toEqual({
      file: "wt.exe",
      args: [
        "-w",
        "0",
        "new-tab",
        "-p",
        "{git}",
        "-d",
        "C:\\a\\;b",
        "C:\\Git\\bin\\bash.exe",
        "-l",
        "-i",
        "-c",
        `claude --resume ${ID}\\; exec bash`,
      ],
      cwd: "C:\\a;b",
    });
  });

  it("opens a new window when asked, for every shell", () => {
    const shells = ["bash", "cmd", "powershell", "pwsh"] as const;
    for (const shell of shells) {
      const profile: WtProfile = { guid: "{p}", name: shell, shell, exe: `${shell}.exe` };
      const tab = wtLaunch("wt.exe", profile, RESUME, "C:\\x", "tab");
      const window = wtLaunch("wt.exe", profile, RESUME, "C:\\x", "window");
      expect(tab.args.slice(0, 3)).toEqual(["-w", "0", "new-tab"]);
      expect(window.args.slice(0, 3)).toEqual(["-w", "new", "new-tab"]);
      expect(window.args.slice(2)).toEqual(tab.args.slice(2));
    }
  });

  it("runs cmd inside a profile whose shell it can't drive", () => {
    const wsl: WtProfile = { guid: "{wsl}", name: "Ubuntu", shell: null, exe: null };
    expect(wtLaunch("wt.exe", wsl, RESUME, "C:\\x").args.slice(7)).toEqual(["cmd.exe", "/k", "claude", "--resume", ID]);
  });

  it("opens a console window with start, leaving the folder off the command line", () => {
    const spec = consoleLaunch("powershell", COPILOT, "C:\\My & Code");
    expect(spec).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"start "" powershell.exe -NoExit -Command "copilot --resume=${ID}""`],
      cwd: "C:\\My & Code",
      verbatim: true,
    });
    expect(consoleLaunch("cmd", RESUME, "C:\\x").args[3]).toBe(`"start "" cmd.exe /k claude --resume ${ID}"`);
  });

  it("fills in a custom template for the platform shell", () => {
    const win = customTerminal("wezterm start --cwd {cwd} -- cmd /k {command}", { platform: "win32" });
    expect(win.launch(RESUME, "C:\\My Code")).toEqual({
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `"wezterm start --cwd "C:\\My Code" -- cmd /k claude --resume ${ID}"`],
      cwd: "C:\\My Code",
      verbatim: true,
    });
    const posix = customTerminal("alacritty --working-directory {cwd} -e {command}", { platform: "linux" });
    expect(posix.launch(RESUME, "/home/me/it's")).toEqual({
      file: "/bin/sh",
      args: ["-c", `alacritty --working-directory '/home/me/it'\\''s' -e claude --resume ${ID}`],
      cwd: "/home/me/it's",
    });
  });

  it("shows a launch the way it would be typed", () => {
    expect(displayLaunch(wtLaunch("C:\\Apps\\wt.exe", bash, RESUME, "C:\\My Code"), "win32")).toBe(
      `wt.exe -w 0 new-tab -p {git} -d "C:\\My Code" C:\\Git\\bin\\bash.exe -l -i -c "claude --resume ${ID}\\; exec bash"`,
    );
  });
});

describe("resolveTerminal", () => {
  const host = (over: Partial<TerminalHost>): TerminalHost => ({
    platform: "win32",
    env: {},
    readFile: () => null,
    which: () => null,
    ...over,
  });

  it("falls back to a cmd window on Windows without Windows Terminal", () => {
    const t = resolveTerminal({ kind: "auto" }, host({}));
    expect([t.label, t.shell]).toEqual(["Command Prompt", "cmd"]);
  });

  it("refuses Windows-only choices elsewhere", () => {
    for (const kind of ["cmd", "powershell"] as const) {
      expect(() => resolveTerminal({ kind }, host({ platform: "darwin" }))).toThrow(/only available on Windows/);
    }
    expect(() => resolveTerminal({ kind: "windows-terminal", profile: "{x}" }, host({ platform: "linux" }))).toThrow(
      /only available on Windows/,
    );
  });

  it("passes open-in to Windows Terminal and leaves other terminals as they were", () => {
    const wt = host({
      env: { LOCALAPPDATA: "L" },
      which: () => "wt.exe",
      readFile: () => `{"profiles": [{"guid": "{c}", "name": "cmd", "commandline": "cmd.exe"}]}`,
    });
    const flag = (t: ResolvedTerminal) => t.launch(RESUME, "C:\\x").args[1];
    expect(flag(resolveTerminal({ kind: "auto" }, wt))).toBe("0");
    expect(flag(resolveTerminal({ kind: "auto" }, wt, "window"))).toBe("new");
    expect(flag(resolveTerminal({ kind: "windows-terminal", profile: "{c}" }, wt, "window"))).toBe("new");
    const cmd = (openIn: "tab" | "window") =>
      resolveTerminal({ kind: "cmd" }, host({}), openIn).launch(RESUME, "C:\\x");
    expect(cmd("window")).toEqual(cmd("tab"));
  });

  it("refuses a Windows Terminal profile that no longer exists", () => {
    expect(() =>
      resolveTerminal({ kind: "windows-terminal", profile: "{gone}" }, host({ which: () => "wt.exe" })),
    ).toThrow(/no longer exists/);
  });

  it("uses Terminal on macOS through AppleScript, escaping the script", () => {
    const t = resolveTerminal({ kind: "auto" }, host({ platform: "darwin" }));
    const spec = t.launch(RESUME, '/Users/me/a "quoted" \\ dir');
    expect(spec.file).toBe("osascript");
    expect(spec.args[1]).toBe(
      `tell application "Terminal" to do script "cd '/Users/me/a \\"quoted\\" \\\\ dir' && claude --resume ${ID}"`,
    );
  });

  it("uses the first terminal found on Linux, and says so when there is none", () => {
    const t = resolveTerminal(
      { kind: "auto" },
      host({ platform: "linux", which: (n) => (n === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null) }),
    );
    expect(t.launch(RESUME, "/srv/my repo").args).toEqual([
      "--",
      "bash",
      "-l",
      "-i",
      "-c",
      `cd '/srv/my repo' && claude --resume ${ID}; exec bash`,
    ]);
    expect(() => resolveTerminal({ kind: "auto" }, host({ platform: "linux" }))).toThrow(/No terminal found/);
  });

  it.each([
    ["x-terminal-emulator", "-e"],
    ["konsole", "-e"],
    ["xfce4-terminal", "-x"],
    ["xterm", "-e"],
  ])("passes the command to %s after %s", (name, flag) => {
    const t = resolveTerminal(
      { kind: "auto" },
      host({ platform: "linux", which: (n) => (n === name ? `/usr/bin/${n}` : null) }),
    );
    expect(t.label).toBe(name);
    expect(t.launch(RESUME, "/srv").args.slice(0, 2)).toEqual([flag, "bash"]);
  });

  it("won't hand cmd a folder containing %, which it would expand", () => {
    const t = customTerminal("wezterm start --cwd {cwd} -- {command}", { platform: "win32" });
    expect(() => t.launch(RESUME, "C:\\100%PATH%x")).toThrow(/containing %/);
  });
});
