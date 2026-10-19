import { BRAND, type CustomScriptLanguage } from "@repo/contracts";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { captureProcess } from "./captureProcess.ts";
import { powershellScript, shellEnvironment, SHELL_OUTPUT_TAIL } from "./shellCommand.ts";

// Autopilot's script actions: a script the user wrote, run in a project's folder by its language's interpreter. As
// with shell actions, task values reach it only as environment variables (and, here, as JSON on stdin): the body is
// never filled in. The body is written to a file in a temp folder of its own and run from there, so nothing is
// quoted onto a command line.

export interface ScriptRequest {
  language: CustomScriptLanguage;
  body: string;
  cwd: string;
  /** Added to the server's environment, after the board's own variables are taken out. */
  env: Record<string, string>;
  /** Written to the script's stdin as JSON. */
  context: unknown;
  timeoutMs: number;
}

export interface ScriptResult {
  /** Null when it was killed (a timeout) or ended by a signal. */
  exitCode: number | null;
  /** The tail of stdout and stderr, interleaved as they came. */
  output: string;
  timedOut: boolean;
  /** What it printed to stdout alone, so a caller can parse it. Cut at STDOUT_MAX (see `stdoutTruncated`). */
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
}

export type RunScript = (request: ScriptRequest) => Promise<ScriptResult>;

/** The interpreter for a language isn't installed (or isn't on the server's PATH). The message is for the run's log. */
export class InterpreterMissingError extends Error {
  constructor(readonly program: string) {
    super(`${program} not found on PATH`);
    this.name = "InterpreterMissingError";
  }
}

/** Makes Windows PowerShell 5.1 read a non-ASCII script as UTF-8 rather than the ANSI code page. */
const BOM = "\uFEFF";

const EXTENSION: Record<CustomScriptLanguage, string> = { python: "py", node: "js", powershell: "ps1", sh: "sh" };

/** The first of `names` that is an executable file on the PATH in `env`, as a full path. */
export function findOnPath(
  names: readonly string[],
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const windows = platform === "win32";
  // Windows treats names case-insensitively, so the variable may be `Path`.
  const pathKey = Object.keys(env).find((k) => (windows ? k.toUpperCase() === "PATH" : k === "PATH"));
  const dirs = (pathKey ? env[pathKey]! : "").split(delimiter).filter(Boolean);
  // Without a shell only real executables start; a .cmd or .bat shim needs cmd.exe.
  const suffixes = windows ? [".exe", ".com"] : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        const file = join(dir, name + suffix);
        try {
          if (!statSync(file).isFile()) continue;
          if (!windows) accessSync(file, constants.X_OK);
          return file;
        } catch {
          // Not here.
        }
      }
    }
  }
  return null;
}

/** What to run for a script file: the program and its arguments, or the name of the program that is missing. */
export function scriptInvocation(
  language: CustomScriptLanguage,
  file: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): { exe: string; args: string[]; env?: Record<string, string> } | { missing: string } {
  const windows = platform === "win32";
  switch (language) {
    case "node":
      // The board's own Node: a user may have none, and this one is known to work. Inside the desktop app that is
      // Electron, which runs a script as Node only when told to.
      return {
        exe: process.execPath,
        args: [file],
        ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
      };
    case "python": {
      // -I ignores the user's PYTHON* variables and site packages and keeps the script's folder off sys.path; -X utf8
      // keeps non-ASCII output intact on a Windows code page. python3 first off Windows, where `python` may be 2; the py launcher first on it, since a machine without Python can have the Store's python.exe stub on the PATH.
      const flags = ["-I", "-X", "utf8", file];
      const names = windows ? ["py", "python", "python3"] : ["python3", "python"];
      for (const name of names) {
        const exe = findOnPath([name], env, platform);
        if (exe) return { exe, args: name === "py" ? ["-3", ...flags] : flags };
      }
      return { missing: "python" };
    }
    case "powershell": {
      const pwsh = findOnPath(["pwsh"], env, platform);
      const exe = pwsh ?? (windows ? findOnPath(["powershell"], env, platform) : null);
      if (!exe) return { missing: windows ? "powershell" : "pwsh" };
      return {
        exe,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          ...(windows ? ["-ExecutionPolicy", "Bypass"] : []),
          "-File",
          file,
        ],
      };
    }
    case "sh": {
      const exe = findOnPath(["sh"], env, platform);
      return exe ? { exe, args: [file] } : { missing: "sh" };
    }
  }
}

/**
 * JSON with every non-ASCII character escaped, so the script reads the same text whatever code page its runtime
 * decodes stdin with (Windows PowerShell reads it as OEM, not UTF-8). Any JSON parser takes it back as it was.
 */
export const asciiJson = (value: unknown): string =>
  JSON.stringify(value)
    .split("")
    .map((ch) => (ch.charCodeAt(0) > 126 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}` : ch))
    .join("");

export const runScript: RunScript = async (request) => {
  const env = shellEnvironment(request.env);
  // Checked before anything is written: a missing interpreter is the user's to fix, not a spawn error.
  const probe = scriptInvocation(request.language, "script", env);
  if ("missing" in probe) throw new InterpreterMissingError(probe.missing);

  const dir = await mkdtemp(join(tmpdir(), `${BRAND.id}-script-`));
  try {
    const body = join(dir, `script.${EXTENSION[request.language]}`);
    // PowerShell gets the same prelude and exit handling as a shell action. The body is run as the file itself, not
    // dot-sourced from a wrapper, which would lose the script's stdin.
    const text = request.language === "powershell" ? BOM + powershellScript(request.body) : request.body;
    await writeFile(body, text, "utf8");
    const invocation = scriptInvocation(request.language, body, env);
    if ("missing" in invocation) throw new InterpreterMissingError(invocation.missing);
    const { exitCode, output, timedOut, stdout, stdoutTruncated, stderr } = await captureProcess({
      exe: invocation.exe,
      args: invocation.args,
      cwd: request.cwd,
      env: { ...env, ...invocation.env },
      stdin: asciiJson(request.context),
      timeoutMs: request.timeoutMs,
      tail: SHELL_OUTPUT_TAIL,
    });
    return { exitCode, output, timedOut, stdout, stdoutTruncated, stderr };
  } finally {
    // A killed tree can hold the file for a moment on Windows.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
};
