import { describe, expect, it } from "vitest";
import { mergeDialogCopy, mergeRepoKey } from "./merge.logic";

describe("mergeRepoKey", () => {
  it("keys by host and repo, case-insensitively", () => {
    expect(mergeRepoKey({ host: "github.com", repo: "Acme/App", number: 1 })).toBe("github.com/acme/app");
    expect(mergeRepoKey({ host: "ghe.example.com", repo: "acme/app", number: 2 })).toBe("ghe.example.com/acme/app");
  });
});

describe("mergeDialogCopy", () => {
  it("words merging and auto-merge differently", () => {
    expect(mergeDialogCopy("merge")).toMatchObject({ title: "Merge pull request", confirm: "Merge" });
    expect(mergeDialogCopy("auto")).toMatchObject({ title: "Enable auto-merge", confirm: "Enable auto-merge" });
    expect(mergeDialogCopy("merge").explain).toContain("isn't deleted");
  });
});
