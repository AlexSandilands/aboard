import type { SocialPost } from "@repo/contracts";

export interface SocialThread {
  root: SocialPost;
  /** Every reply under the root, at any depth, oldest first. */
  replies: SocialPost[];
}

/**
 * Posts grouped into threads, the newest activity first. A reply joins its root's thread; one whose post is gone
 * (pruned) starts its own.
 */
export function socialThreads(posts: readonly SocialPost[]): SocialThread[] {
  const byId = new Map(posts.map((post) => [post.id, post]));
  const rootOf = (post: SocialPost): SocialPost => {
    let current = post;
    const seen = new Set<number>();
    while (current.replyTo !== null && byId.has(current.replyTo) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.replyTo)!;
    }
    return current;
  };
  const threads = new Map<number, SocialThread>();
  for (const post of [...posts].sort((a, b) => a.id - b.id)) {
    const root = rootOf(post);
    const thread = threads.get(root.id) ?? { root, replies: [] };
    if (post.id !== root.id) thread.replies.push(post);
    threads.set(root.id, thread);
  }
  const latest = (thread: SocialThread) => thread.replies.at(-1)?.id ?? thread.root.id;
  return [...threads.values()].sort((a, b) => latest(b) - latest(a));
}

/** What a post goes by: the handle the agent chose, or "anonymous". */
export const socialHandle = (post: Pick<SocialPost, "handle">): string => post.handle ?? "anonymous";
