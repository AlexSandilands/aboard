import { CustomAction } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { inheritedVariables, missingIn, rowsToVariables, variableNeeds, variablesChanged } from "./variables.logic";

describe("the variables editor", () => {
  it("saves named rows, drops blank ones and names a bad row", () => {
    expect(
      rowsToVariables([
        { name: " jira_key ", value: "ABC" },
        { name: "", value: " " },
      ]),
    ).toEqual({ ok: true, variables: [{ name: "jira_key", value: "ABC" }] });
    expect(rowsToVariables([{ name: "Jira", value: "x" }])).toMatchObject({
      ok: false,
      error: /"Jira": Use lowercase/,
    });
    expect(rowsToVariables([{ name: "", value: "orphan" }])).toMatchObject({ ok: false, error: /Variable 1/ });
    expect(
      rowsToVariables([
        { name: "a", value: "1" },
        { name: "a", value: "2" },
      ]),
    ).toMatchObject({ ok: false, error: /set twice/ });
  });

  it("knows when the rows differ from what is saved", () => {
    const saved = [{ name: "a", value: "1" }];
    expect(variablesChanged([{ name: "a", value: "1" }], saved)).toBe(false);
    expect(
      variablesChanged(
        [
          { name: "a", value: "1" },
          { name: "", value: "" },
        ],
        saved,
      ),
    ).toBe(false);
    expect(variablesChanged([{ name: "a", value: "2" }], saved)).toBe(true);
  });

  it("lists the board's variables a project doesn't override", () => {
    const board = [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ];
    expect(inheritedVariables(board, [{ name: " a ", value: "" }])).toEqual([{ name: "b", value: "2" }]);
  });
});

describe("what an action needs", () => {
  const action = CustomAction.parse({ kind: "agent", prompt: "Triage {{vars.jira_key}} for {{vars.team}}" });
  const board = [{ name: "team", value: "core" }];
  const projects = [
    { id: "s", title: "billing", variables: [{ name: "jira_key", value: "BILL" }] },
    { id: "a", title: "aboard", variables: [] },
  ];

  it("lists each variable with the projects that have no value for it", () => {
    expect(variableNeeds(action, board, projects)).toEqual([
      { name: "jira_key", missingIn: ["aboard"] },
      { name: "team", missingIn: [] },
    ]);
    expect(missingIn(action, board, projects[1]!)).toEqual(["jira_key"]);
    expect(missingIn(action, board, projects[0]!)).toEqual([]);
  });
});
