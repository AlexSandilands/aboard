import { OperationId, OPERATIONS, type OperationSettings } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  boardPickerRows,
  boardPickerValue,
  boardUpdate,
  OPERATION_DESCRIPTIONS,
  OPERATION_GROUPS,
} from "./operations.logic";

const settings = (over: Partial<OperationSettings> = {}): OperationSettings => ({
  modelTiers: {
    light: { description: null, t3: null, cli: { "claude-code": "haiku" } },
    standard: { description: null, t3: null, cli: { "claude-code": "sonnet" } },
    deep: { description: null, t3: null, cli: { "claude-code": "opus" } },
  },
  modelProfiles: [],
  operationModels: {},
  providers: [{ id: "claude-code", enabled: true }],
  ...over,
});

describe("OPERATION_GROUPS", () => {
  it("puts every operation in exactly one group, each with a description", () => {
    const listed = OPERATION_GROUPS.flatMap((group) => group.operations);
    expect([...listed].sort()).toEqual([...OperationId.options].sort());
    expect(new Set(listed).size).toBe(listed.length);
    for (const op of listed) expect(OPERATION_DESCRIPTIONS[op]).toBeTruthy();
  });
});

describe("boardPickerRows", () => {
  it("offers the task's own model apart from Default where the default is a tier", () => {
    const rows = boardPickerRows("boardReviewer", settings());
    expect(rows.unset.detail).toBe("Claude Code · sonnet");
    expect(rows.inherit?.label).toBe("The task's own model");
  });

  it("offers only Default where it already is the task's own model, or there is no task", () => {
    expect(boardPickerRows("taskRun", settings()).inherit).toBeNull();
    expect(boardPickerRows("taskRun", settings()).unset.detail).toBe("The task's own model");
    expect(boardPickerRows("digest", settings()).inherit).toBeNull();
  });

  it("names the default in Default's detail, not what the board saved", () => {
    const saved = settings({ operationModels: { digest: { tier: "deep" } } });
    expect(boardPickerRows("digest", saved).unset.detail).toBe("Claude Code · haiku");
  });
});

describe("boardPickerValue", () => {
  it("keeps a saved inherit where it differs from Default, and reads it as Default elsewhere", () => {
    expect(boardPickerValue("boardReviewer", { boardReviewer: "inherit" })).toBe("inherit");
    expect(boardPickerValue("taskRun", { taskRun: "inherit" })).toBeNull();
    expect(boardPickerValue("digest", { digest: "inherit" })).toBeNull();
    expect(boardPickerValue("digest", { digest: { tier: "deep" } })).toEqual({ tier: "deep" });
    expect(boardPickerValue("digest", {})).toBeNull();
  });
});

describe("boardUpdate", () => {
  it("removes the board's setting for Default and saves anything else", () => {
    expect(boardUpdate("digest", null)).toEqual({ digest: null });
    expect(boardUpdate("prReview", OPERATIONS.prReview.default)).toEqual({ prReview: { tier: "standard" } });
  });
});
