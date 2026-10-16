import { describe, expect, it } from "vitest";
import { parseToolList } from "./issueImport.logic";

describe("parseToolList", () => {
  it("splits on commas and whitespace and drops blanks and repeats", () => {
    expect(parseToolList("mcp__a__get_jira_issue, mcp__b__getJiraIssue  mcp__a__get_jira_issue,")).toEqual([
      "mcp__a__get_jira_issue",
      "mcp__b__getJiraIssue",
    ]);
    expect(parseToolList("  ")).toEqual([]);
  });
});
