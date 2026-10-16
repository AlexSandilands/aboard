import type { TaskImport } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { importFailure, importPendingLabel, importSourceLabel } from "./import.logic";

const imp = (
  status: TaskImport["status"],
  error: string | null = null,
  sourceUrl = "PROJ-1",
): { import: TaskImport } => ({ import: { status, error, sourceUrl } });

describe("import labels", () => {
  it("names where the import reads from", () => {
    expect(importSourceLabel("PROJ-1")).toBe("Jira PROJ-1");
    expect(importSourceLabel("https://jira.example.com/browse/PROJ-2")).toBe("Jira PROJ-2");
    expect(importSourceLabel("https://github.com/acme/app/issues/45")).toBe("GitHub acme/app#45");
  });

  it("shows fetching only while pending", () => {
    expect(importPendingLabel(imp("pending"))).toBe("Fetching details…");
    expect(importPendingLabel(imp("done"))).toBeNull();
    expect(importPendingLabel({ import: null })).toBeNull();
  });

  it("explains a failure with the reason", () => {
    expect(importFailure(imp("failed", "No Jira tool available"))).toEqual({
      title: "Couldn't import Jira PROJ-1",
      reason: "No Jira tool available",
    });
    expect(importFailure(imp("pending"))).toBeNull();
    expect(importFailure({ import: null })).toBeNull();
  });
});
