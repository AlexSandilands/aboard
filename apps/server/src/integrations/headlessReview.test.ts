import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headlessArgs, headlessPrompt, parseHeadlessOutput, resolveExecutable } from "./headlessReview.ts";

describe("headless review", () => {
  it("runs read-only, without MCP servers, within the budget", () => {
    const args = headlessArgs(1.5);
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("1.5");
    expect(args).toContain("Bash(git diff *)");
    expect(args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--disallowedTools") + 4)).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
    ]);
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({ required: ["summary", "findings"] });
  });

  it("puts the task inline and diffs against the base branch", () => {
    const prompt = headlessPrompt({
      taskNumber: 7,
      round: 2,
      taskText: "#7 Add exports [Review]",
      skill: { source: "global", name: "review-loop", path: "/h/skills/review-loop/SKILL.md" },
      baseRef: "origin/main",
    });
    expect(prompt).toContain("review round 2");
    expect(prompt).toContain("`git merge-base HEAD origin/main`");
    expect(prompt).not.toContain("$(");
    expect(prompt).toContain('"review-loop" at /h/skills/review-loop/SKILL.md');
    expect(prompt).toContain("#7 Add exports [Review]");
  });

  it("parses structured findings and surfaces failures", () => {
    const ok = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.42,
      structured_output: { summary: "One bug", findings: [{ severity: "major", title: "Off by one", line: 3 }] },
    });
    expect(parseHeadlessOutput(`warning: something\n${ok}\n`)).toEqual({
      summary: "One bug",
      findings: [{ severity: "major", title: "Off by one", line: 3 }],
      costUsd: 0.42,
    });
    const budget = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true });
    expect(() => parseHeadlessOutput(budget)).toThrow("error max budget usd");
    expect(() => parseHeadlessOutput("")).toThrow("no JSON result");
  });

  it("resolves commands on PATH with Windows extensions", () => {
    const dir = mkdtempSync(join(tmpdir(), "headless-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "claude.EXE"), "");
    const env = { PATH: join(dir, "bin"), PATHEXT: ".COM;.EXE" };
    expect(resolveExecutable("claude", env, "win32")?.toLowerCase()).toBe(join(dir, "bin", "claude.exe").toLowerCase());
    expect(resolveExecutable("missing", env, "win32")).toBeNull();
    expect(resolveExecutable(join(dir, "bin", "claude"), env, "win32")).not.toBeNull();
  });
});
