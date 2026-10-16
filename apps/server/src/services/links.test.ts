import type { PrSnapshot, TaskStatus } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "../test/harness.ts";
import { GITHUB_ACTOR } from "./links.ts";

const pr = (state: PrSnapshot["state"]): PrSnapshot => ({
  state,
  title: "Change",
  checks: "passing",
  reviewDecision: null,
  mergeable: "mergeable",
  headRef: "feat/x",
  updatedAt: "2026-10-01T10:00:00Z",
});

function setup(status: TaskStatus = "review", prNumbers: number[] = [1]) {
  const h = createTestHarness();
  const s = h.services;
  const project = s.projects.create({ title: "Alpha", workspaceRoot: "/work/alpha" });
  const task = s.tasks.create({
    projectId: project.id,
    title: "Ship it",
    plan: { phases: [{ title: "Build", steps: [{ title: "a" }] }] },
    links: prNumbers.map((n) => ({ value: `https://github.com/acme/app/pull/${n}` })),
  });
  if (status !== "planned") s.tasks.move(task.id, { status }, "agent");
  const links = s.links.listByKind("pr").filter((l) => l.taskId === task.id);
  const currentStatus = () => s.tasks.summary(task.id).status;
  return { ...h, s, task, links, status: currentStatus };
}

describe("moving Review tasks to Done when their PR merges", () => {
  it("moves a Review task when its only PR merges, logged as github with the PR", () => {
    const { s, task, links, status, events } = setup();
    s.links.setSnapshot(links[0]!.id, pr("open"));
    expect(status()).toBe("review");
    events.length = 0;

    s.links.setSnapshot(links[0]!.id, pr("merged"));

    expect(status()).toBe("done");
    expect(s.tasks.detail(task.id).events.at(-1)).toMatchObject({
      type: "status_changed",
      actor: GITHUB_ACTOR,
      payload: { from: "review", to: "done", mergedPr: "acme/app#1" },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "task.upserted", task: expect.objectContaining({ status: "done" }) }),
    );
  });

  it("counts a first snapshot that is already merged as the merge", () => {
    const { s, links, status } = setup();
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("done");
  });

  it.each(["planned", "in_progress"] as const)("leaves a task in %s alone", (initial) => {
    const { s, links, status } = setup(initial);
    s.links.setSnapshot(links[0]!.id, pr("open"));
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe(initial);
  });

  it("does not pull back a task the user moved out of Done after the merge", () => {
    const { s, task, links, status } = setup();
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    s.tasks.move(task.id, { status: "review" }, "user");
    // Later polls report the same merged PR, possibly with fresher fields.
    s.links.setSnapshot(links[0]!.id, { ...pr("merged"), checks: "failing" });
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("review");
  });

  it("ignores archived tasks", () => {
    const { s, task, links, status } = setup();
    s.tasks.update(task.id, { archived: true }, "user");
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("review");
  });

  it("waits for every PR to be merged or closed", () => {
    const { s, links, status } = setup("review", [1, 2]);
    s.links.setSnapshot(links[1]!.id, pr("open"));
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("review");
    // Closing the remaining PR finishes the task, credited to the one that merged.
    s.links.setSnapshot(links[1]!.id, pr("closed"));
    expect(status()).toBe("done");
  });

  it("treats a PR that was never fetched as still open", () => {
    const { s, links, status } = setup("review", [1, 2]);
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("review");
    s.links.setSnapshot(links[1]!.id, pr("merged"));
    expect(status()).toBe("done");
  });

  it("does not move a task whose PRs were all closed without merging", () => {
    const { s, links, status } = setup("review", [1, 2]);
    s.links.setSnapshot(links[0]!.id, pr("closed"));
    s.links.setSnapshot(links[1]!.id, pr("closed"));
    expect(status()).toBe("review");
  });

  it("ignores PR links that are never polled", () => {
    const { s, task, links, status } = setup();
    s.links.add(task.id, { value: "https://gitlab.com/acme/app/-/merge_requests/3", kind: "pr" }, "agent");
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("done");
  });

  it("ignores PRs on hosts gh isn't signed in to, though they parse as GitHub PRs", () => {
    const { s, task, links, status } = setup();
    // The harness's gh status is unknown: only github.com holds a task back.
    s.links.add(task.id, { value: "https://github.example.com/team/svc/pull/3" }, "agent");
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("done");
  });

  it("keeps counting an Enterprise PR fetched before, though its host isn't polled right now", () => {
    const { s, task, links, status } = setup();
    const ghe = s.links.add(task.id, { value: "https://github.example.com/team/svc/pull/3" }, "agent");
    s.links.setSnapshot(ghe.id, pr("open"));
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    expect(status()).toBe("review");
  });
});

describe("completing tasks that enter Review with their PRs already merged", () => {
  const upserts = (events: ReturnType<typeof setup>["events"], taskId: string) =>
    events.flatMap((e) => (e.type === "task.upserted" && e.task.id === taskId ? [e.task.status] : []));

  it("moves on to Done as github when every PR is finished and one merged", () => {
    const { s, task, links, status, events } = setup("in_progress", [1, 2]);
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    s.links.setSnapshot(links[1]!.id, pr("closed"));
    expect(status()).toBe("in_progress");
    events.length = 0;

    const summary = s.tasks.move(task.id, { status: "review" }, "agent");

    expect(summary.status).toBe("done");
    expect(s.tasks.detail(task.id).events.slice(-2)).toMatchObject([
      { type: "status_changed", actor: "agent", payload: { from: "in_progress", to: "review" } },
      {
        type: "status_changed",
        actor: GITHUB_ACTOR,
        payload: { from: "review", to: "done", mergedPr: `acme/app#${links[0]!.url.split("/").at(-1)}` },
      },
    ]);
    // Both moves share one write, so clients only ever see the final state.
    expect(upserts(events, task.id)).toEqual(["done"]);
  });

  it("does the same for a move through the REST API", async () => {
    const { s, task, links, request, status } = setup("in_progress");
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    const res = await request(`/api/tasks/${task.id}/move`, { method: "POST", json: { status: "review" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "done" });
    expect(status()).toBe("done");
  });

  it("stays in Review while a PR is still open", () => {
    const { s, task, links, status } = setup("in_progress", [1, 2]);
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    s.links.setSnapshot(links[1]!.id, pr("open"));
    s.tasks.move(task.id, { status: "review" }, "agent");
    expect(status()).toBe("review");
  });

  it("stays in Review without PR links", () => {
    const { s, task, status } = setup("in_progress", []);
    s.tasks.move(task.id, { status: "review" }, "agent");
    expect(status()).toBe("review");
  });

  it("stays in Review when moved back from Done", () => {
    const { s, task, links, status } = setup("in_progress");
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    s.tasks.move(task.id, { status: "done" }, "agent");
    s.tasks.move(task.id, { status: "review" }, "user");
    expect(status()).toBe("review");
  });

  it("ignores archived tasks", () => {
    const { s, task, links, status } = setup("in_progress");
    s.links.setSnapshot(links[0]!.id, pr("merged"));
    s.tasks.update(task.id, { archived: true }, "user");
    s.tasks.move(task.id, { status: "review" }, "user");
    expect(status()).toBe("review");
  });
});
