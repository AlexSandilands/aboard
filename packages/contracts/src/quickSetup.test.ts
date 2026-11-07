import { describe, expect, it } from "vitest";
import {
  QUICK_SETUP_LEVELS,
  QUICK_SETUP_PRESETS,
  quickSetupChanges,
  quickSetupSummary,
  quickSetupWrites,
  type QuickSetupInput,
} from "./quickSetup.ts";

const catalogue = [
  "start_planned",
  "orchestrate",
  "review_prs",
  "fix_prs",
  "merge_epic_prs",
  "digest",
  "auto_archive",
  "unstick",
  "unblock_dependents",
].map((key) => ({ key, title: key, blocked: null as string | null }));

const input = (overrides: Partial<QuickSetupInput> = {}): QuickSetupInput => ({
  automations: catalogue,
  board: [],
  ...overrides,
});

describe("quickSetupChanges", () => {
  it("only names automations the catalogue has", () => {
    for (const level of QUICK_SETUP_LEVELS) {
      for (const item of QUICK_SETUP_PRESETS[level].items) {
        expect(catalogue.map((a) => a.key)).toContain(item.automation);
      }
    }
  });

  it("Notify switches on only automations that start no agent and merge nothing", () => {
    const changes = quickSetupChanges("notify", input());
    expect(changes.map((c) => c.automation)).toEqual(["digest", "unstick", "unblock_dependents", "auto_archive"]);
    expect(changes.every((c) => c.kind === "switch_on" && c.mode === "on")).toBe(true);
  });

  it("Assist starts the agent automations in Preview and the rest On", () => {
    const changes = quickSetupChanges("assist", input());
    const modes = Object.fromEntries(changes.flatMap((c) => (c.kind === "switch_on" ? [[c.automation, c.mode]] : [])));
    expect(modes).toEqual({
      review_prs: "preview",
      fix_prs: "preview",
      digest: "on",
      unstick: "on",
      auto_archive: "on",
    });
  });

  it("Hands-off adds starting, orchestrating and merging, in Preview, and never reaches main on its own", () => {
    const changes = quickSetupChanges("hands_off", input());
    expect(changes.map((c) => c.automation)).toEqual([
      "start_planned",
      "orchestrate",
      "review_prs",
      "fix_prs",
      "merge_epic_prs",
      "unstick",
      "auto_archive",
    ]);
    expect(quickSetupWrites(changes).filter((w) => w.mode === "preview")).toHaveLength(5);
    const merge = changes.find((c) => c.automation === "merge_epic_prs");
    expect(merge?.kind === "switch_on" && merge.detail).toContain("main stays off");
  });

  it("starts them live when Preview is switched off", () => {
    const writes = quickSetupWrites(quickSetupChanges("hands_off", input({ preview: false })));
    expect(writes.every((w) => w.mode === "on")).toBe(true);
  });

  it("leaves what is already on as it is, in its own mode", () => {
    const changes = quickSetupChanges(
      "assist",
      input({
        board: [
          { automation: "review_prs", mode: "on" },
          { automation: "digest", mode: "preview" },
        ],
      }),
    );
    expect(changes.find((c) => c.automation === "review_prs")).toMatchObject({ kind: "already_on", mode: "on" });
    expect(changes.find((c) => c.automation === "digest")).toMatchObject({ kind: "already_on", mode: "preview" });
    expect(quickSetupWrites(changes).map((w) => w.automation)).toEqual(["fix_prs", "unstick", "auto_archive"]);
  });

  it("switches on an automation the board has off or inherits, and not one that is blocked", () => {
    const blocked = catalogue.map((a) =>
      a.key === "fix_prs" ? { ...a, blocked: "Won't work until you fill in: tools" } : a,
    );
    const changes = quickSetupChanges(
      "assist",
      input({ automations: blocked, board: [{ automation: "review_prs", mode: "off" }] }),
    );
    expect(changes.find((c) => c.automation === "review_prs")?.kind).toBe("switch_on");
    expect(changes.find((c) => c.automation === "fix_prs")).toMatchObject({
      kind: "blocked",
      reason: "Won't work until you fill in: tools",
    });
    expect(quickSetupWrites(changes).map((w) => w.automation)).not.toContain("fix_prs");
  });

  it("says where a project's own Off keeps an automation from running", () => {
    const changes = quickSetupChanges(
      "assist",
      input({
        projects: [
          { title: "billing", entries: [{ automation: "review_prs", mode: "off" }] },
          { title: "web", entries: [{ automation: "review_prs", mode: "inherit" }] },
        ],
      }),
    );
    const review = changes.find((c) => c.automation === "review_prs");
    expect(review?.kind === "switch_on" && review.overriddenIn).toEqual(["billing"]);
  });

  it("leaves out a preset automation the catalogue doesn't have", () => {
    const without = catalogue.filter((a) => a.key !== "unblock_dependents");
    expect(quickSetupChanges("notify", input({ automations: without })).map((c) => c.automation)).not.toContain(
      "unblock_dependents",
    );
  });
});

describe("quickSetupSummary", () => {
  it("counts what went on and what went to Preview", () => {
    const changes = quickSetupChanges("assist", input());
    expect(quickSetupSummary("assist", changes)).toBe("Assist applied: 3 on, 2 in Preview");
  });

  it("says when there was nothing to do", () => {
    const board = catalogue.map((a) => ({ automation: a.key, mode: "on" as const }));
    expect(quickSetupSummary("notify", quickSetupChanges("notify", input({ board })))).toBe(
      "Notify: everything it covers is already on",
    );
  });
});
