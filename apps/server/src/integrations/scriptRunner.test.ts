import { brandEnv } from "@repo/contracts";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROCESS_TEST_TIMEOUT } from "../test/timeouts.ts";
import { STDOUT_MAX } from "./captureProcess.ts";
import {
  asciiJson,
  findOnPath,
  InterpreterMissingError,
  runScript,
  scriptInvocation,
  type ScriptRequest,
} from "./scriptRunner.ts";

const windows = process.platform === "win32";
const TITLE = brandEnv("TASK_TITLE");
const PATHS = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() === "PATH")) as Record<
  string,
  string
>;
const has = (name: string) => findOnPath([name], PATHS) !== null;

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "script-runner-test-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const run = (request: Partial<ScriptRequest> & Pick<ScriptRequest, "language" | "body">) =>
  runScript({ cwd: tmpdir(), env: {}, context: {}, timeoutMs: 30_000, ...request });

// Real interpreters. Node is the server's own, so it is there wherever the tests run; the others run when installed.
describe("runScript with node", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("runs in the folder with the values as variables and the context on stdin", async () => {
    // The long name: a Windows temp dir can be a short 8.3 name (RUNNER~1), which the child reports in full.
    const cwd = realpathSync.native(tmpdir());
    const context = { automation: "Ping", task: { title: "Fix é it" } };
    const result = await run({
      language: "node",
      cwd,
      env: { [TITLE]: "Fix it" },
      context,
      body: `
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => {
          process.stdout.write(JSON.stringify({ cwd: process.cwd(), title: process.env.${TITLE}, input }));
        });
      `,
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdoutTruncated: false, stderr: "" });
    const seen = JSON.parse(result.stdout) as { cwd: string; title: string; input: string };
    expect(seen).toMatchObject({ cwd, title: "Fix it" });
    // Non-ASCII text is escaped, so any runtime reads it whatever its code page; a JSON parser undoes that.
    expect(seen.input).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(seen.input)).toEqual(context);
  });

  it("keeps stdout apart from stderr, and the exit code", async () => {
    const result = await run({
      language: "node",
      body: "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    });
    expect(result).toMatchObject({ exitCode: 3, stdout: "out", stderr: "err", timedOut: false });
    expect(result.output).toHaveLength(6);
  });

  it("keeps the tail of the output but the start of stdout, which a reader parses", async () => {
    const result = await run({
      language: "node",
      body: `process.stdout.write("a".repeat(10) + "b".repeat(${STDOUT_MAX + 1_000}))`,
    });
    expect(result.output).toHaveLength(4_000);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).toHaveLength(STDOUT_MAX);
    expect(result.stdout.startsWith("aaaaaaaaaab")).toBe(true);
  });

  it("takes out the board's own variables, API token included, and keeps the rest", async () => {
    const token = brandEnv("TOKEN");
    process.env[token] = "secret";
    try {
      const result = await run({
        language: "node",
        env: { [TITLE]: "t" },
        body: `process.stdout.write(JSON.stringify({ own: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith(${JSON.stringify(brandEnv("").toUpperCase())})), path: Boolean(process.env.PATH ?? process.env.Path) }))`,
      });
      expect(JSON.parse(result.stdout)).toEqual({ own: [TITLE], path: true });
    } finally {
      delete process.env[token];
    }
  });

  it("stops a script that runs past its timeout", async () => {
    const result = await run({ language: "node", body: "setTimeout(() => {}, 30000)", timeoutMs: 300 });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    // taskkill is slow on Windows.
  }, 20_000);

  it("ends the programs a timed-out script started", async () => {
    const dir = tempDir();
    const marker = join(dir, "grandchild.txt");
    const started = join(dir, "started.txt");
    // It says it started, so a slow Node start-up fails the test rather than passing it without a grandchild.
    const grandchild = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "up"); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 6000)`;
    const result = await run({
      language: "node",
      timeoutMs: 3_000,
      body: `
        const { spawn } = require("node:child_process");
        spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
        setTimeout(() => {}, 30000);
      `,
    });
    expect(result.timedOut).toBe(true);
    expect(existsSync(started)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it("removes its temp folder, whether the script succeeds or fails", async () => {
    const printFile = "process.stdout.write(__filename); ";
    const ok = await run({ language: "node", body: printFile });
    const failed = await run({ language: "node", body: `${printFile}process.exit(1)` });
    for (const result of [ok, failed]) {
      expect(result.stdout).toMatch(/script\.js$/);
      expect(existsSync(dirname(result.stdout))).toBe(false);
    }
  });

  it("is told apart from a syntax error by its exit code and stderr", async () => {
    const result = await run({ language: "node", body: "this is not javascript" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/SyntaxError/);
  });
});

describe.skipIf(windows)("runScript with sh", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("runs the script with the values as variables and the context on stdin", async () => {
    const result = await run({
      language: "sh",
      env: { [TITLE]: "Fix it" },
      context: { automation: "Ping" },
      body: `printf '%s|' "$${TITLE}"; cat; exit 4`,
    });
    expect(result).toMatchObject({ exitCode: 4, stdout: `Fix it|{"automation":"Ping"}`, timedOut: false });
  });
});

describe.skipIf(!windows)("runScript with PowerShell", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("runs the script with the values as variables, the context on stdin and non-ASCII text intact", async () => {
    const result = await run({
      language: "powershell",
      env: { [TITLE]: "Fix é it" },
      context: { automation: "Ping é" },
      body: `Write-Output $env:${TITLE}\n$input | ForEach-Object { Write-Output $_ }`,
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const [title, input] = result.stdout.trim().split(/\r?\n/);
    expect(title).toBe("Fix é it");
    expect(JSON.parse(input!)).toEqual({ automation: "Ping é" });
  });

  it("gives an exit code and fails for a failing cmdlet", async () => {
    const exit = await run({ language: "powershell", body: "exit 5", timeoutMs: 60_000 });
    expect(exit.exitCode).toBe(5);
    const cmdlet = await run({ language: "powershell", body: "Get-Item C:\\no\\such\\file", timeoutMs: 60_000 });
    expect(cmdlet.exitCode).toBe(1);
  });
});

describe.skipIf(!has("pwsh") || windows)("runScript with pwsh", { timeout: PROCESS_TEST_TIMEOUT }, () => {
  it("runs the script and keeps its exit code", async () => {
    const result = await run({ language: "powershell", body: "Write-Output $env:HOME; exit 2", timeoutMs: 60_000 });
    expect(result.exitCode).toBe(2);
  });
});

describe.skipIf(!has("python3") && !has("python") && !has("py"))("runScript with python", () => {
  it(
    "runs the script with the context on stdin, isolated from the user's PYTHON variables",
    async () => {
      const result = await run({
        language: "python",
        env: { PYTHONSTARTUP: "/no/such/file", PYTHONPATH: "/no/such/dir" },
        context: { automation: "Ping é" },
        body: `import json, os, sys\nprint(json.dumps({"stdin": json.load(sys.stdin), "pythonpath": os.environ.get("PYTHONPATH")}))\nsys.exit(6)`,
        timeoutMs: 60_000,
      });
      expect(result.exitCode).toBe(6);
      expect(JSON.parse(result.stdout)).toEqual({ stdin: { automation: "Ping é" }, pythonpath: "/no/such/dir" });
    },
    PROCESS_TEST_TIMEOUT,
  );
});

describe("a missing interpreter", () => {
  it("fails with its name, not a spawn error, and writes nothing", async () => {
    // Windows names the variable `Path`, and a key of either case is read.
    const none = { PATH: "", Path: "" };
    await expect(run({ language: "sh", body: "echo hi", env: none })).rejects.toThrow(
      new InterpreterMissingError("sh"),
    );
    await expect(run({ language: "python", body: "print(1)", env: none })).rejects.toThrow("python not found on PATH");
  });
});

describe("asciiJson", () => {
  it("escapes what isn't ASCII, astral characters as surrogate pairs, and parses back to the same value", () => {
    const value = { a: "é", b: "😀", c: 'plain "quoted"\n' };
    const text = asciiJson(value);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).toContain("\\u00e9");
    expect(text).toContain("\\ud83d\\ude00");
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe("scriptInvocation", () => {
  /** A folder holding empty programs of those names. */
  const bin = (...names: string[]) => {
    const dir = tempDir();
    for (const name of names) {
      const file = join(dir, name);
      writeFileSync(file, "");
      chmodSync(file, 0o755);
    }
    return { PATH: dir };
  };

  it("runs python isolated, taking python3 off Windows and python, then py -3, on it", () => {
    const flags = ["-I", "-X", "utf8", "s.py"];
    const linux = scriptInvocation("python", "s.py", bin("python", "python3"), "linux");
    expect(linux).toMatchObject({ args: flags });
    expect((linux as { exe: string }).exe).toMatch(/python3$/);
    expect(scriptInvocation("python", "s.py", bin("python"), "linux")).toMatchObject({ args: flags });
    expect(scriptInvocation("python", "s.py", bin("py.exe", "python.exe"), "win32")).toMatchObject({
      args: ["-3", ...flags],
    });
    const python = scriptInvocation("python", "s.py", bin("python.exe"), "win32") as { exe: string; args: string[] };
    expect(python.exe).toMatch(/python\.exe$/);
    expect(python.args).toEqual(flags);
    expect(scriptInvocation("python", "s.py", bin("node"), "linux")).toEqual({ missing: "python" });
  });

  it("prefers pwsh to Windows PowerShell, which only Windows has", () => {
    const pwsh = scriptInvocation("powershell", "s.ps1", bin("pwsh.exe", "powershell.exe"), "win32") as { exe: string };
    expect(pwsh.exe).toMatch(/pwsh\.exe$/);
    const legacy = scriptInvocation("powershell", "s.ps1", bin("powershell.exe"), "win32") as {
      exe: string;
      args: string[];
    };
    expect(legacy.exe).toMatch(/powershell\.exe$/);
    expect(legacy.args).toEqual(
      expect.arrayContaining(["-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "s.ps1"]),
    );
    expect(scriptInvocation("powershell", "s.ps1", bin("powershell"), "linux")).toEqual({ missing: "pwsh" });
    expect(scriptInvocation("powershell", "s.ps1", bin(), "win32")).toEqual({ missing: "powershell" });
  });

  it("runs node as the server's own and, inside Electron, as Node", () => {
    const invocation = scriptInvocation("node", "s.js", {}, "linux");
    expect(invocation).toMatchObject({ exe: process.execPath, args: ["s.js"] });
    expect("env" in invocation).toBe(Boolean(process.versions.electron));
  });

  it("finds a program in a PATH variable of any case on Windows, and only an executable elsewhere", () => {
    const dir = bin("tool.exe", "plain").PATH;
    expect(findOnPath(["tool"], { Path: dir }, "win32")).toBe(join(dir, "tool.exe"));
    expect(findOnPath(["tool"], { Path: dir }, "linux")).toBeNull();
    expect(findOnPath(["plain"], { PATH: dir }, "linux")).toBe(join(dir, "plain"));
  });

  // Windows has no executable bit.
  it.skipIf(windows)("skips a file that isn't executable", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "data"), "");
    chmodSync(join(dir, "data"), 0o644);
    expect(findOnPath(["data"], { PATH: dir }, "linux")).toBeNull();
  });
});
