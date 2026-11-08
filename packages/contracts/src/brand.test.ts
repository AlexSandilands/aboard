import { describe, expect, it } from "vitest";
import { BRAND_REPOSITORY, parseGitHubRepository } from "./brand.ts";

describe("parseGitHubRepository", () => {
  it("reads the forms package.json allows", () => {
    for (const url of [
      "git+https://github.com/acme/board.git",
      "https://github.com/acme/board",
      "https://github.com/acme/board/",
      "git@github.com:acme/board.git",
      "ssh://git@github.com/acme/board.git",
      "github:acme/board",
    ]) {
      expect(parseGitHubRepository(url)).toEqual({ owner: "acme", repo: "board" });
    }
  });

  it("keeps dots and dashes in names", () => {
    expect(parseGitHubRepository("https://github.com/a-b/c.d-e.git")).toEqual({ owner: "a-b", repo: "c.d-e" });
  });

  it("is null for other hosts and partial URLs", () => {
    for (const url of ["https://gitlab.com/acme/board.git", "https://github.com/acme", "acme/board", ""]) {
      expect(parseGitHubRepository(url)).toBeNull();
    }
  });

  it("finds this repo's own", () => {
    expect(BRAND_REPOSITORY).not.toBeNull();
  });
});
