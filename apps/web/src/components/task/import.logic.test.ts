import { TICKET_SYSTEM_PRESETS, type TaskImport } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { epicImportProgress, importFailure, importPendingLabel, importSourceLabel } from "./import.logic";

const imp = (
  status: TaskImport["status"],
  error: string | null = null,
  sourceUrl = "PROJ-1",
): { import: TaskImport } => ({ import: { status, error, sourceUrl } });

const systems = [TICKET_SYSTEM_PRESETS[0]!.system];

describe("import labels", () => {
  it("names where the import reads from", () => {
    expect(importSourceLabel("PROJ-1", systems)).toBe("Jira PROJ-1");
    expect(importSourceLabel("https://jira.example.com/browse/PROJ-2", systems)).toBe("Jira PROJ-2");
    expect(importSourceLabel("PROJ-1")).toBe("PROJ-1");
    expect(importSourceLabel("https://github.com/acme/app/issues/45")).toBe("GitHub acme/app#45");
  });

  it("shows fetching only while pending", () => {
    expect(importPendingLabel(imp("pending"))).toBe("Fetching details…");
    expect(importPendingLabel(imp("done"))).toBeNull();
    expect(importPendingLabel({ import: null })).toBeNull();
  });

  it("explains a failure with the reason", () => {
    expect(importFailure(imp("failed", "No import tool available"), systems)).toEqual({
      title: "Couldn't import Jira PROJ-1",
      reason: "No import tool available",
    });
    expect(importFailure(imp("pending"))).toBeNull();
    expect(importFailure({ import: null })).toBeNull();
  });
});

describe("epicImportProgress", () => {
  const child = (status: TaskImport["status"] | null) => ({
    import: status ? { status, error: null, sourceUrl: "PROJ-2" } : null,
  });
  const epic = (children: Array<{ import: TaskImport | null }>) => ({
    kind: "epic" as const,
    ...imp("done"),
    children,
  });

  it("counts the epic's imported tasks that have finished, while some haven't", () => {
    expect(epicImportProgress(epic([child("done"), child("failed"), child("pending"), child(null)]))).toEqual({
      done: 2,
      total: 3,
    });
  });

  it("is null once they all have, for an epic nobody imported, and for a task", () => {
    expect(epicImportProgress(epic([child("done"), child(null)]))).toBeNull();
    expect(epicImportProgress({ ...epic([child("pending")]), import: null })).toBeNull();
    expect(epicImportProgress({ ...epic([child("pending")]), kind: "task" })).toBeNull();
  });
});
