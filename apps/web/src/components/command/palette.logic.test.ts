import { describe, expect, it } from "vitest";
import {
  filterBrowseEntries,
  filterItems,
  isPathQuery,
  issueImportRow,
  normalizeDescription,
  queryForEntry,
  queryForParent,
  resolveSubmitPath,
  splitBrowseQuery,
  startsBrowseFromRoot,
  taskSearchTerms,
  trimTrailingSeparators,
} from "./palette.logic";

describe("isPathQuery", () => {
  it("recognises POSIX, home, UNC and drive paths", () => {
    for (const value of ["~", "~/", "~\\foo", "/usr", "\\\\server\\share", "C:", "c:\\Code", "D:/x"]) {
      expect(isPathQuery(value)).toBe(true);
    }
    for (const value of ["", "foo", "my project", "./rel"]) {
      expect(isPathQuery(value)).toBe(false);
    }
  });
});

describe("startsBrowseFromRoot", () => {
  it("needs a separator after ~ or a drive", () => {
    for (const value of ["~/", "~\\", "/", "\\", "C:\\", "c:/"]) expect(startsBrowseFromRoot(value)).toBe(true);
    for (const value of ["~", "C:", "a:b", "#12", "go"]) expect(startsBrowseFromRoot(value)).toBe(false);
  });
});

describe("splitBrowseQuery", () => {
  it.each([
    ["~/", { directory: "~/", leaf: "" }],
    ["~", { directory: "~", leaf: "" }],
    ["~/Co", { directory: "~/", leaf: "Co" }],
    ["~\\Code\\fo", { directory: "~\\Code\\", leaf: "fo" }],
    ["C:\\Code\\foo", { directory: "C:\\Code\\", leaf: "foo" }],
    ["C:/Code/foo", { directory: "C:/Code/", leaf: "foo" }],
    ["C:\\Code/foo", { directory: "C:\\Code/", leaf: "foo" }],
    ["C:", { directory: "C:\\", leaf: "" }],
    ["C:\\", { directory: "C:\\", leaf: "" }],
    ["/", { directory: "/", leaf: "" }],
    ["/home/al", { directory: "/home/", leaf: "al" }],
  ])("%s", (query, expected) => {
    expect(splitBrowseQuery(query)).toEqual(expected);
  });
});

describe("filterBrowseEntries", () => {
  const entries = [{ name: "Code" }, { name: "code-old" }, { name: ".config" }, { name: "Documents" }];
  it("matches the leaf case-insensitively by prefix", () => {
    expect(filterBrowseEntries(entries, "co").map((e) => e.name)).toEqual(["Code", "code-old"]);
    expect(filterBrowseEntries(entries, "").map((e) => e.name)).toEqual(["Code", "code-old", "Documents"]);
  });
  it("shows dot-folders only when the leaf starts with a dot", () => {
    expect(filterBrowseEntries(entries, ".").map((e) => e.name)).toEqual([".config"]);
  });
});

describe("queryForEntry", () => {
  it("appends in the user's separator style", () => {
    expect(queryForEntry("~/Co", { name: "Code", fullPath: "/home/a/Code" }, "/home/a")).toBe("~/Code/");
    expect(queryForEntry("C:\\Co", { name: "Code", fullPath: "C:\\Code" }, "C:\\")).toBe("C:\\Code\\");
    expect(queryForEntry("C:/", { name: "Code", fullPath: "C:\\Code" }, "C:\\")).toBe("C:/Code/");
    expect(queryForEntry("~\\", { name: "src", fullPath: "C:\\Users\\a\\src" }, "C:\\Users\\a")).toBe("~\\src\\");
  });
  it("adds the separator a bare ~ or drive is missing", () => {
    expect(queryForEntry("~", { name: "Code", fullPath: "/home/a/Code" }, "/home/a")).toBe("~/Code/");
    expect(queryForEntry("D:", { name: "src", fullPath: "D:\\src" }, "D:\\")).toBe("D:\\src\\");
  });
  it("replaces the query with a drive root from the drive list", () => {
    expect(queryForEntry("/", { name: "D:", fullPath: "D:\\" }, "/")).toBe("D:\\");
  });
});

describe("queryForParent", () => {
  it("adds a trailing separator in the path's style", () => {
    expect(queryForParent("C:\\Users")).toBe("C:\\Users\\");
    expect(queryForParent("C:\\")).toBe("C:\\");
    expect(queryForParent("/home")).toBe("/home/");
    expect(queryForParent("/")).toBe("/");
  });
});

describe("trimTrailingSeparators", () => {
  it("keeps roots intact", () => {
    expect(trimTrailingSeparators("C:\\Code\\")).toBe("C:\\Code");
    expect(trimTrailingSeparators("C:\\")).toBe("C:\\");
    expect(trimTrailingSeparators("C:/")).toBe("C:\\");
    expect(trimTrailingSeparators("/")).toBe("/");
    expect(trimTrailingSeparators("/home/a//")).toBe("/home/a");
  });
});

describe("resolveSubmitPath", () => {
  const listing = {
    path: "C:\\Users\\a",
    parentPath: "C:\\Users",
    entries: [
      { name: "Code", fullPath: "C:\\Users\\a\\Code" },
      { name: "code-old", fullPath: "C:\\Users\\a\\code-old" },
    ],
  };
  it("adds the listed folder when there is no leaf", () => {
    expect(resolveSubmitPath("~\\", listing)).toEqual({ ok: true, path: "C:\\Users\\a" });
  });
  it("adds the exactly named child, preferring case-sensitive matches", () => {
    expect(resolveSubmitPath("~/Code", listing)).toEqual({ ok: true, path: "C:\\Users\\a\\Code" });
    expect(resolveSubmitPath("~/code", listing)).toEqual({ ok: true, path: "C:\\Users\\a\\Code" });
    expect(resolveSubmitPath("~/CODE-OLD", listing)).toEqual({ ok: true, path: "C:\\Users\\a\\code-old" });
  });
  it("rejects missing folders, non-paths and the drive list", () => {
    expect(resolveSubmitPath("~/nope", listing)).toEqual({ ok: false, reason: 'No folder named "nope"' });
    expect(resolveSubmitPath("hello", listing).ok).toBe(false);
    expect(resolveSubmitPath("~/", undefined).ok).toBe(false);
    expect(
      resolveSubmitPath("/", { path: "/", parentPath: null, entries: [{ name: "C:", fullPath: "C:\\" }] }).ok,
    ).toBe(false);
  });
  it("handles POSIX listings", () => {
    const posix = { path: "/home/a", parentPath: "/home", entries: [{ name: "src", fullPath: "/home/a/src" }] };
    expect(resolveSubmitPath("/home/a/src/", { ...posix, path: "/home/a/src", entries: [] })).toEqual({
      ok: true,
      path: "/home/a/src",
    });
    expect(resolveSubmitPath("/home/a/src", posix)).toEqual({ ok: true, path: "/home/a/src" });
  });
});

describe("filterItems", () => {
  const items = [
    { title: "New task…", searchTerms: ["create", "capture"] },
    { title: "Add project…", searchTerms: ["folder", "workspace"] },
    { title: "Go to project…", searchTerms: ["jump", "filter"] },
  ];
  it("keeps everything for an empty query", () => {
    expect(filterItems(items, "  ")).toEqual(items);
  });
  it("requires every token and ranks title prefixes first", () => {
    expect(filterItems(items, "project").map((i) => i.title)).toEqual(["Add project…", "Go to project…"]);
    expect(filterItems(items, "go proj").map((i) => i.title)).toEqual(["Go to project…"]);
    expect(filterItems(items, "folder").map((i) => i.title)).toEqual(["Add project…"]);
  });
  it("finds tasks by #number", () => {
    const tasks = [
      { title: "Fix login", searchTerms: taskSearchTerms({ number: 12, title: "Fix login" }, "web") },
      { title: "Ship 12 things", searchTerms: taskSearchTerms({ number: 3, title: "Ship 12 things" }, "web") },
      { title: "Other", searchTerms: taskSearchTerms({ number: 123, title: "Other" }, "web") },
    ];
    expect(filterItems(tasks, "#12").map((t) => t.title)).toEqual(["Fix login", "Other"]);
    expect(filterItems(tasks, "12")[0]?.title).toBe("Fix login");
  });
  it("finds tasks by label", () => {
    const tasks = [
      {
        title: "Fix login",
        searchTerms: taskSearchTerms({ number: 1, title: "Fix login", labels: ["backend"] }, "web"),
      },
      { title: "Header", searchTerms: taskSearchTerms({ number: 2, title: "Header", labels: ["ui"] }, "web") },
    ];
    expect(filterItems(tasks, "backend").map((t) => t.title)).toEqual(["Fix login"]);
  });
});

describe("normalizeDescription", () => {
  it("treats blank input as not set", () => {
    expect(normalizeDescription("")).toBeUndefined();
    expect(normalizeDescription("  \n\t ")).toBeUndefined();
  });

  it("trims surrounding whitespace but keeps inner newlines", () => {
    expect(normalizeDescription("\n first\n\nsecond  ")).toBe("first\n\nsecond");
  });
});

describe("issueImportRow", () => {
  it("offers to import a Jira key, a Jira URL and a GitHub issue", () => {
    expect(issueImportRow("PROJ-123", "backlog")).toMatchObject({
      sourceUrl: "PROJ-123",
      title: "Import PROJ-123 from Jira",
    });
    expect(issueImportRow("  https://jira.example.com/browse/PROJ-9 ", "backlog")).toMatchObject({
      sourceUrl: "https://jira.example.com/browse/PROJ-9",
      title: "Import PROJ-9 from Jira",
    });
    expect(issueImportRow("https://github.com/acme/app/issues/45", "backlog")).toMatchObject({
      title: "Import acme/app#45 from GitHub",
    });
  });

  it("leaves ordinary titles, pull requests and planned tasks alone", () => {
    expect(issueImportRow("Fix PROJ-123 login", "backlog")).toBeNull();
    expect(issueImportRow("https://github.com/acme/app/pull/45", "backlog")).toBeNull();
    expect(issueImportRow("UTF-8", "backlog")).toBeNull();
    expect(issueImportRow("PROJ-123", "planned")).toBeNull();
  });
});
