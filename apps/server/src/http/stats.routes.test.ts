import { StatsResponse } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";

describe("GET /api/stats", () => {
  it("defaults to 12 weeks for the whole board and answers with the contract's shape", async () => {
    const h = createTestHarness();
    const res = await h.request("/api/stats");
    expect(res.status).toBe(200);
    const body = StatsResponse.parse(await res.json());
    expect(body).toMatchObject({ weeks: 12, projects: [] });
    expect(body.buckets).toHaveLength(12);
  });

  it("takes 1 (by day), 4, 12 or 52 weeks and a project", async () => {
    const h = createTestHarness();
    const project = h.services.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
    for (const weeks of [1, 4, 12, 52]) {
      const body = StatsResponse.parse(await (await h.request(`/api/stats?weeks=${weeks}`)).json());
      expect(body.buckets).toHaveLength(weeks === 1 ? 7 : weeks);
      expect(body.bucket).toBe(weeks === 1 ? "day" : "week");
    }
    const scoped = StatsResponse.parse(await (await h.request(`/api/stats?projectId=${project.id}`)).json());
    expect(scoped.projects).toEqual([{ id: project.id, title: "Alpha" }]);
    const other = h.services.projects.create({ title: "Beta", workspaceRoot: "/work/beta" });
    const subset = StatsResponse.parse(
      await (await h.request(`/api/stats?projectIds=${other.id},${project.id}&projectId=${project.id}`)).json(),
    );
    expect(subset.projects.map((p) => p.title)).toEqual(["Beta", "Alpha"]);
  });

  it("rejects other periods, and a project that isn't there", async () => {
    const h = createTestHarness();
    for (const query of ["weeks=7", "weeks=0", "weeks=abc", "weeks=4.5", "projectId="]) {
      expect((await h.request(`/api/stats?${query}`)).status).toBe(400);
    }
    expect((await h.request("/api/stats?projectId=nope")).status).toBe(404);
    expect((await h.request("/api/stats?projectIds=nope,other")).status).toBe(404);
  });
});
