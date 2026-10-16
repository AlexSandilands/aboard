import { brandEnv } from "@repo/contracts";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runShellCommand, shellEnvironment } from "./shellCommand.ts";

// A real shell: node is on PATH wherever the tests run, and the command is quoted the same for cmd.exe and sh.
const node = (script: string) => `node -e "${script}"`;

describe("runShellCommand", () => {
  it("runs in the folder with the values as environment variables, not interpolated", async () => {
    const title = '"; echo injected; & echo injected & $(echo injected)';
    const result = await runShellCommand({
      command: node(`process.stdout.write(process.cwd() + '|' + process.env.${brandEnv("TASK_TITLE")})`),
      cwd: tmpdir(),
      env: { [brandEnv("TASK_TITLE")]: title },
      timeoutMs: 20_000,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toBe(`${tmpdir()}|${title}`);
  });

  it("keeps the exit code and the tail of the output", async () => {
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
