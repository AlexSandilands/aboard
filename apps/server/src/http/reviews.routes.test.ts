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

    const fix = await h.request(`/api/tasks/${h.task.id}/review-prompt`);
    expect(((await fix.json()) as { prompt: string }).prompt).toContain("round 2 is open");

    const rounds = (await (await h.request(`/api/tasks/${h.task.id}/reviews`)).json()) as TaskReview[];
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
  });

  it("names the reviewer's model in the prompt once one is set at any level", async () => {
    const h = setup();
    h.services.reviews.openRound(h.task.id, { trigger: "manual", actor: "agent" });
    const promptOf = async () =>
      ((await (await h.request(`/api/tasks/${h.task.id}/review-prompt`)).json()) as { prompt: string }).prompt;
    expect(await promptOf()).not.toContain("Run the reviewer on");

    h.services.settings.update({ reviewModel: { model: "claude-opus-5-5" } });
    expect(await promptOf()).toContain('Run the reviewer on `claude-opus-5-5`: in Claude Code pass `model: "opus"`');
    h.services.tasks.update(h.task.id, { reviewModel: { model: "sonnet" } }, "user");
    expect(await promptOf()).toContain('Run the reviewer on `sonnet`: in Claude Code pass `model: "sonnet"`');
  });

  it("asks to fix open blocking findings before another round", async () => {
    const h = setup();
    h.services.reviews.submit(h.task.id, { findings: [{ severity: "blocking", title: "x" }] }, "reviewer");
    const res = await h.request(`/api/tasks/${h.task.id}/review-prompt`);
    expect(((await res.json()) as { prompt: string }).prompt).toContain("found blocking or major issues");
  });

  it("lists skills without reading the real home folder", async () => {
    const h = setup();
    const res = await h.request(`/api/skills?projectId=${h.project.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()) as SkillInfo[]).toEqual([]);
  });
});
