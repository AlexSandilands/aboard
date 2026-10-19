import { customEnvName, CustomScriptLanguage, parseCheckOutput } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  isStarter,
  itemsSummary,
  languageOfFile,
  SCRIPT_LANGUAGES,
  scriptNeeds,
  scriptStarter,
  testHeadline,
} from "./scripts.logic";

describe("the languages", () => {
  it("cover every language the contract allows, node said to need nothing", () => {
    expect(SCRIPT_LANGUAGES.map((l) => l.value).sort()).toEqual([...CustomScriptLanguage.options].sort());
    expect(scriptNeeds("node")).toMatch(/Always available/);
    for (const { value } of SCRIPT_LANGUAGES) expect(scriptNeeds(value)).not.toBe("");
  });

  it("are guessed from a file's name", () => {
    expect(languageOfFile("check.py")).toBe("python");
    expect(languageOfFile("a.MJS")).toBe("node");
    expect(languageOfFile("run.ps1")).toBe("powershell");
    expect(languageOfFile("go.sh")).toBe("sh");
    expect(languageOfFile("notes.txt")).toBeNull();
  });
});

describe("the starters", () => {
  it("show the stdin context in every language, and the JSON-lines output in a check's", () => {
    for (const { value } of SCRIPT_LANGUAGES) {
      expect(scriptStarter(value, "check")).toContain("key");
      expect(scriptStarter(value, "check")).not.toBe(scriptStarter(value, "action"));
    }
    expect(scriptStarter("node", "check")).toContain("readFileSync(0");
    expect(scriptStarter("python", "check")).toContain("json.load(sys.stdin)");
    expect(scriptStarter("powershell", "check")).toContain("ConvertFrom-Json");
    expect(scriptStarter("sh", "check")).toContain(customEnvName("PROJECT_NAME"));
  });

  it("end with a newline and carry no tabs", () => {
    for (const { value } of SCRIPT_LANGUAGES) {
      for (const role of ["action", "check"] as const) {
        const text = scriptStarter(value, role);
        expect(text.endsWith("\n")).toBe(true);
        expect(text).not.toContain("\t");
      }
    }
  });

  it("don't name a placeholder the board would refuse in a script", () => {
    for (const { value } of SCRIPT_LANGUAGES) {
      expect(scriptStarter(value, "check")).not.toMatch(/\{\{\s*(?:task|pr|project|automation|inputs)\./);
    }
  });

  it("print lines the board reads as items", () => {
    const printed = '{"key":"example-1","title":"Something to look at in Alpha"}';
    expect(parseCheckOutput(printed)).toMatchObject({ ok: true, items: [{ key: "example-1" }] });
  });

  it("are told apart from what the user wrote", () => {
    expect(isStarter("", "check")).toBe(true);
    expect(isStarter(scriptStarter("python", "check"), "check")).toBe(true);
    expect(isStarter(scriptStarter("python", "check"), "action")).toBe(false);
    expect(isStarter(`${scriptStarter("python", "check")}print(1)`, "check")).toBe(false);
  });
});

describe("a test run's result", () => {
  const base = { error: null, exitCode: 0, timedOut: false, durationMs: 1200 };

  it("is green only for a clean exit", () => {
    expect(testHeadline(base)).toEqual({ tone: "success", text: "Exited 0 in 1.2 s" });
    expect(testHeadline({ ...base, exitCode: 2, durationMs: 40 })).toEqual({
      tone: "error",
      text: "Exited with 2 after 40 ms",
    });
    expect(testHeadline({ ...base, exitCode: null, timedOut: true }).tone).toBe("warning");
    expect(testHeadline({ ...base, exitCode: null }).text).toMatch(/a signal/);
    expect(testHeadline({ ...base, error: "no pwsh", exitCode: null })).toEqual({
      tone: "error",
      text: "Couldn't run",
    });
  });

  it("says how many agents a check would start", () => {
    expect(itemsSummary({ items: [], dropped: 0, prompt: null })).toMatch(/no agent/);
    expect(itemsSummary({ items: [{ key: "a" }], dropped: 0, prompt: null })).toMatch(/^1 item\./);
    expect(itemsSummary({ items: [{ key: "a" }, { key: "b" }], dropped: 3, prompt: null })).toMatch(
      /^2 items \(3 more/,
    );
    expect(itemsSummary({ problem: "Line 1 isn't JSON" })).toMatch(/fail and start no agent/);
  });
});
