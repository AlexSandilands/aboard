import type { Project, TaskTemplate } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import {
  draftFromTask,
  emptyForm,
  followTemplate,
  formFromDraft,
  formFromTemplate,
  formToInput,
  parseLabels,
  prefillFrom,
  scopeLabel,
  templateSummary,
  templatesFor,
} from "./templates.logic";

const template = (over: Partial<TaskTemplate> = {}): TaskTemplate => ({
  id: "t1",
  name: "Bug",
  projectId: null,
  titlePattern: "",
  description: null,
  labels: ["bug"],
  planContext: null,
  phases: [{ title: "Fix", steps: [{ title: "Reproduce" }, { title: "Fix", notes: "carefully" }] }],
  suggestedTier: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
  ...over,
});

describe("parseLabels", () => {
  it("normalises, drops blanks and dedupes", () => {
    expect(parseLabels("UI, back end,, #ui , ")).toEqual(["ui", "back-end"]);
    expect(parseLabels("")).toEqual([]);
  });
});

describe("formToInput", () => {
  it("needs a name", () => {
    expect(formToInput(emptyForm())).toEqual({ ok: false, error: "Give the template a name" });
  });

  it("round-trips a template through the form", () => {
    const original = template({
      projectId: "p1",
      titlePattern: "Fix {{date}}",
      description: "## What",
      planContext: "why",
      suggestedTier: "light",
    });
    const result = formToInput(formFromTemplate(original));
    expect(result).toEqual({
      ok: true,
      input: {
        name: "Bug",
        projectId: "p1",
        titlePattern: "Fix {{date}}",
        description: "## What",
        labels: ["bug"],
        planContext: "why",
        phases: original.phases,
        suggestedTier: "light",
      },
    });
  });

  it("turns blank text into null and drops empty steps and phases", () => {
    const form = formFromTemplate(template({ description: "x", planContext: "y" }));
    form.description = "  ";
    form.planContext = "";
    form.outline[0]!.steps[0]!.title = "  ";
    form.outline.push({ key: "extra", title: "Empty", steps: [{ key: "s", title: "" }] });
    const result = formToInput(form);
    expect(result.ok && result.input).toMatchObject({
      description: null,
      planContext: null,
      phases: [{ title: "Fix", steps: [{ title: "Fix", notes: "carefully" }] }],
    });
  });

  it("gives a template with no plan no phases", () => {
    const form = { ...emptyForm(), name: "Notes" };
    const result = formToInput(form);
    expect(result.ok && result.input.phases).toEqual([]);
  });
});

describe("draftFromTask", () => {
  it("copies the task's fields and leaves its progress behind", () => {
    const draft = draftFromTask({
      title: "Weekly review",
      description: "Look at the board",
      labels: ["ops"],
      planContext: "ctx",
      projectId: "p1",
      suggestedModel: { tier: "deep", reason: "hard" },
      phases: [
        {
          id: "ph",
          title: "Review",
          position: "a0",
          steps: [
            {
              id: "s1",
              phaseId: "ph",
              title: "Read",
              notes: "all",
              status: "done",
              position: "a0",
              startedAt: "x",
              completedAt: "y",
              updatedAt: "z",
            },
          ],
        },
        { id: "empty", title: "Nothing", position: "a1", steps: [] },
      ],
    });
    expect(draft).toEqual({
      name: "Weekly review",
      projectId: "p1",
      titlePattern: "Weekly review",
      description: "Look at the board",
      labels: ["ops"],
      planContext: "ctx",
      phases: [{ title: "Review", steps: [{ title: "Read", notes: "all" }] }],
      suggestedTier: "deep",
    });
    expect(formFromDraft(draft).outline[0]!.steps[0]).toMatchObject({ title: "Read", notes: "all" });
  });
});

describe("templatesFor", () => {
  it("lists board-wide templates first, then the project's, and leaves other projects out", () => {
    const all = [
      template({ id: "a", name: "Mine", projectId: "p1" }),
      template({ id: "b", name: "Other", projectId: "p2" }),
      template({ id: "c", name: "Everywhere" }),
    ];
    expect(templatesFor(all, "p1").map((t) => t.id)).toEqual(["c", "a"]);
  });
});

describe("prefillFrom", () => {
  it("renders placeholders in the title and description", () => {
    const filled = prefillFrom(
      template({ titlePattern: "Review {{date}}", description: "For {{project}}" }),
      { title: "Alpha" },
      new Date(2026, 9, 6),
    );
    expect(filled).toEqual({ title: "Review 2026-10-06", description: "For Alpha" });
  });
});

describe("followTemplate", () => {
  it("follows the template until the user edits the field", () => {
    expect(followTemplate("", "", "Bug: ")).toBe("Bug: ");
    expect(followTemplate("Bug:", "Bug:", "Spike:")).toBe("Spike:");
    expect(followTemplate("My own title", "Bug:", "Spike:")).toBe("My own title");
    expect(followTemplate("  ", "Bug:", "")).toBe("");
  });
});

describe("labels in the list", () => {
  const projects = [{ id: "p1", title: "Alpha" }] as Project[];
  it("summarises the plan and labels", () => {
    expect(templateSummary(template())).toBe("2 steps · bug");
    expect(templateSummary(template({ phases: [{ title: "P", steps: [{ title: "s" }] }], labels: [] }))).toBe("1 step");
    expect(templateSummary(template({ phases: [], labels: [] }))).toBe("No plan");
  });
  it("names the scope", () => {
    expect(scopeLabel(template(), projects)).toBe("All projects");
    expect(scopeLabel(template({ projectId: "p1" }), projects)).toBe("Alpha");
  });
});
