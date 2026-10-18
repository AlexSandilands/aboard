import type { SocialPost } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { socialHandle, socialThreads } from "./feed.logic";

const post = (id: number, replyTo: number | null = null): SocialPost => ({
  id,
  handle: null,
  kind: "text",
  body: `post ${id}`,
  replyTo,
  createdAt: "2026-10-01T12:00:00Z",
  task: null,
  sessionId: null,
});

const shape = (posts: SocialPost[]) =>
  socialThreads(posts).map((t) => [t.root.id, t.replies.map((r) => r.id)] as const);

describe("socialThreads", () => {
  it("groups replies at any depth under their root, oldest first", () => {
    expect(shape([post(1), post(2, 1), post(3), post(4, 2)])).toEqual([
      [1, [2, 4]],
      [3, []],
    ]);
  });

  it("puts the thread with the newest post first", () => {
    expect(shape([post(1), post(2), post(3, 1)]).map(([root]) => root)).toEqual([1, 2]);
    expect(shape([post(1), post(2)]).map(([root]) => root)).toEqual([2, 1]);
  });

  it("starts a thread for a reply whose post was pruned", () => {
    expect(shape([post(5, 3), post(6, 5)])).toEqual([[5, [6]]]);
  });

  it("calls a post without a handle anonymous", () => {
    expect(socialHandle({ handle: null })).toBe("anonymous");
    expect(socialHandle({ handle: "otter" })).toBe("otter");
  });
});
