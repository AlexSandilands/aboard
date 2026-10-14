import type { TaskSummary } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { closeCandidates, closeDialogTitle, resolutionLabel } from "./resolution.logic";

const task = (number: number, title: string, projectId = "p") =>
  ({ id: `t${number}`, number, title, projectId }) as TaskSummary;

describe("resolutionLabel", () => {
  const by = { id: "t4", number: 4, title: "Ship it" };
  it("names the delivering task", () => {
    expect(resolutionLabel({ resolution: "completed", resolvedBy: by })).toBe("Done by #4");
    expect(resolutionLabel({ resolution: "duplicate", resolvedBy: by })).toBe("Duplicate of #4");
  });
  it("copes with a deleted delivering task and open tasks", () => {
    expect(resolutionLabel({ resolution: "completed", resolvedBy: null })).toBe("Done elsewhere");
    expect(resolutionLabel({ resolution: "wont_do", resolvedBy: null })).toBe("Won't do");
    expect(resolutionLabel({ resolution: null, resolvedBy: null })).toBeNull();
  });
});

describe("closeDialogTitle", () => {
  it("reads per resolution", () => {
    expect(closeDialogTitle(20, "completed")).toBe("Close #20 as done by…");
    expect(closeDialogTitle(20, "duplicate")).toBe("Close #20 as a duplicate of…");
  });
});

describe("closeCandidates", () => {
  const self = task(20, "Search titles");
  const tasks = [self, task(4, "Ship search"), task(7, "Dark mode"), task(9, "Search other", "q")];

  it("excludes the task itself and puts its own project first, newest first", () => {
    expect(closeCandidates(tasks, self, "").map((t) => t.number)).toEqual([7, 4, 9]);
  });
  it("matches #number, bare number and every title word", () => {
    expect(closeCandidates(tasks, self, "#4").map((t) => t.number)).toEqual([4]);
    expect(closeCandidates(tasks, self, "7").map((t) => t.number)).toEqual([7]);
    expect(closeCandidates(tasks, self, "search ship").map((t) => t.number)).toEqual([4]);
    expect(closeCandidates(tasks, self, "search").map((t) => t.number)).toEqual([4, 9]);
  });
});
