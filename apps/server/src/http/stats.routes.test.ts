import { StatsResponse } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

describe("GET /api/stats", () => {
  it("defaults to 12 weeks for the whole board and answers with the contract's shape", async () => {
    const h = createTestHarness();
    const res = await h.request("/api/stats");
    expect(res.status).toBe(200);
    const body = StatsResponse.parse(await res.json());
    expect(body).toMatchObject({ weeks: 12, project: null });
    expect(body.buckets).toHaveLength(12);
  });

  it("takes 4, 12 or 52 weeks and a project", async () => {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    for (const weeks of [4, 12, 52]) {
      const body = StatsResponse.parse(await (await h.request(`/api/stats?weeks=${weeks}`)).json());
      expect(body.buckets).toHaveLength(weeks);
    }
    const scoped = StatsResponse.parse(await (await h.request(`/api/stats?projectId=${project.id}`)).json());
    expect(scoped.project).toEqual({ id: project.id, title: "Alpha" });
  });

  it("rejects other periods, and a project that isn't there", async () => {
    const h = createTestHarness();
    for (const query of ["weeks=7", "weeks=0", "weeks=abc", "weeks=4.5", "projectId="]) {
      expect((await h.request(`/api/stats?${query}`)).status).toBe(400);
    }
    expect((await h.request("/api/stats?projectId=nope")).status).toBe(404);
  });
});
