import type { ReviewFinding, SkillInfo, TaskReview } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

function setup() {
  const h = createTestHarness();
  const project = h.services.projects.create({ title: "P", workspaceRoot: "/nonexistent/work" });
  const task = h.services.tasks.create({
    projectId: project.id,
    title: "T",
    plan: { phases: [{ title: "a", steps: [{ title: "b" }] }] },
  });
  return { ...h, project, task };
}

describe("review REST routes", () => {
  it("starts rounds past the limit for the user, and resolves findings by label", async () => {
    const h = setup();
    h.services.settings.update({ reviewMaxRounds: 1 });
    h.services.reviews.submit(h.task.id, { findings: [{ severity: "major", title: "x" }] }, "reviewer");

    const started = await h.request(`/api/tasks/%23${h.task.number}/reviews`, { method: "POST" });
    expect(started.status).toBe(201);
    expect(((await started.json()) as TaskReview).round).toBe(2);

    const prompt = (await (await h.request(`/api/tasks/${h.task.id}/review-prompt`)).json()) as { prompt: string };
    expect(prompt.prompt).toContain("round 2 is open");

    const resolved = await h.request(`/api/tasks/${h.task.id}/findings/R1.1`, {
      method: "PATCH",
      json: { status: "wont_fix", note: "Out of scope" },
    });
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as ReviewFinding).status).toBe("wont_fix");

    const rounds = (await (await h.request(`/api/tasks/${h.task.id}/reviews`)).json()) as TaskReview[];
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
  });

  it("lists skills without reading the real home folder", async () => {
    const h = setup();
    const res = await h.request(`/api/skills?projectId=${h.project.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as SkillInfo[]).toEqual([]);
  });
});
