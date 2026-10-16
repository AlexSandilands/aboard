import { brandEnv } from "@repo/contracts";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runShellCommand, shellEnvironment, shellInvocation } from "./shellCommand.ts";

// A real shell: PowerShell on Windows, /bin/sh elsewhere. node is on PATH wherever the tests run, and a script in
// double quotes with no `$` in it reads the same to both.
const node = (script: string) => `node -e "${script}"`;
const TITLE = brandEnv("TASK_TITLE");
/** Prints the title variable the way the guide says to read it on this platform. */
const echoTitle = process.platform === "win32" ? `Write-Output $env:${TITLE}` : `printf '%s\\n' "$${TITLE}"`;

describe("runShellCommand", () => {
  it("runs in the folder with the values as environment variables", async () => {
    const result = await runShellCommand({
      command: node(`process.stdout.write(process.cwd() + '|' + process.env.${TITLE})`),
      cwd: tmpdir(),
      env: { [TITLE]: "Fix it" },
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toBe(`${tmpdir()}|Fix it`);
  });

  it("never runs a value as part of the command", async () => {
    const title = `a" & echo INJECTED & "; echo INJECTED; $(echo INJECTED) \`echo INJECTED\` %PATH% | echo INJECTED`;
    const result = await runShellCommand({
      command: echoTitle,
      cwd: tmpdir(),
      env: { [TITLE]: title },
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(title);
  });

  it("keeps a program's exit code and the tail of the output", async () => {
    const result = await runShellCommand({
      command: node("process.stdout.write('x'.repeat(10000)); process.stderr.write('end'); process.exit(3)"),
      cwd: tmpdir(),
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.output.length).toBe(4000);
    expect(result.output.endsWith("end")).toBe(true);
  });

  it("stops a command that runs past its timeout", async () => {
    const result = await runShellCommand({
      command: node("setTimeout(() => {}, 30000)"),
      cwd: tmpdir(),
      env: {},
      timeoutMs: 300,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    // taskkill and PowerShell's start-up are slow on Windows.
  }, 20_000);
});

describe("shellInvocation", () => {
  it("encodes the command for PowerShell on Windows, so nothing reaches cmd.exe", () => {
    const [exe, args] = shellInvocation('echo "a" & b', "win32");
    expect(exe).toBe("powershell.exe");
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    expect(script).toContain('\necho "a" & b\n');
    expect(args).toContain("-EncodedCommand");
  });

  it("hands the command to /bin/sh elsewhere", () => {
    expect(shellInvocation("make check", "linux")).toEqual(["/bin/sh", ["-c", "make check"]]);
  });
});

describe("shellEnvironment", () => {
  it("drops the board's own variables, whatever their case, and adds the action's", () => {
    const env = shellEnvironment(
      { [brandEnv("TASK_ID")]: "t1" },
      { PATH: "/bin", [brandEnv("TOKEN")]: "secret", [brandEnv("HOME").toLowerCase()]: "/x" },
    );
    expect(env).toEqual({ PATH: "/bin", [brandEnv("TASK_ID")]: "t1" });
  });
});
