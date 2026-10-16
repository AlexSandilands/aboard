import type { TerminalInfo } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_TEMPLATE, terminalOptions, terminalOptionValue, terminalSettingFor } from "./terminal.logic";

const windows: TerminalInfo = {
  platform: "win32",
  autoLabel: "Windows Terminal (Git Bash)",
  profiles: [
    { guid: "{git}", name: "Git Bash", shell: "bash" },
    { guid: "{wsl}", name: "Ubuntu", shell: null },
  ],
  defaultProfile: "{git}",
  preview: null,
  error: null,
};

describe("terminal settings", () => {
  it("lists auto, the profiles, the Windows shells and custom", () => {
    expect(terminalOptions(windows).map((o) => [o.value, o.detail])).toEqual([
      ["auto", "Windows Terminal (Git Bash)"],
      ["wt:{git}", "bash"],
      ["wt:{wsl}", "runs cmd"],
      ["cmd", undefined],
      ["powershell", undefined],
      ["custom", undefined],
    ]);
  });

  it("offers only auto and custom elsewhere", () => {
    const mac = { ...windows, platform: "darwin", profiles: [], autoLabel: "Terminal" };
    expect(terminalOptions(mac).map((o) => o.value)).toEqual(["auto", "custom"]);
  });

  it("round-trips settings through the select's values", () => {
    for (const setting of [
      { kind: "auto" },
      { kind: "windows-terminal", profile: "{git}" },
      { kind: "cmd" },
    ] as const) {
      expect(terminalSettingFor(terminalOptionValue(setting), { kind: "auto" })).toEqual(setting);
    }
    expect(terminalSettingFor("custom", { kind: "auto" })).toEqual({
      kind: "custom",
      template: DEFAULT_CUSTOM_TEMPLATE,
    });
    expect(terminalSettingFor("custom", { kind: "custom", template: "x {command}" })).toEqual({
      kind: "custom",
      template: "x {command}",
    });
    expect(terminalSettingFor("nope", { kind: "auto" })).toBeNull();
  });
});
