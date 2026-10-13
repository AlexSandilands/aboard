import { describe, expect, it } from "vitest";
import { createTestHarness } from "./test/harness.ts";

describe("app", () => {
  it("serves health and migrates the database", async () => {
    const h = createTestHarness();
    const res = await h.request("/api/health");
    expect(res.status).toBe(200);
    const tables = h.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["projects", "tasks", "plan_steps", "task_links"]));
  });

  it("rejects foreign hosts and origins", async () => {
    const h = createTestHarness();
    expect((await h.request("/api/health", { headers: { host: "evil.example" } })).status).toBe(403);
    expect((await h.request("/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await h.request("/api/health", { headers: { origin: "http://localhost:5317" } })).status).toBe(200);
  });
});
