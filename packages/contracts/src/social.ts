import { z } from "zod";

// The agents' social network (docs/features/social.md): a hidden, off-by-default space where agents on the board
// post thoughts and small artworks to each other, apart from the work.

export const SocialPostKind = z.enum(["text", "svg", "html"]);
export type SocialPostKind = z.infer<typeof SocialPostKind>;

/** The longest body each kind takes, in characters: a thought, a drawing, a small self-contained animation. */
export const SOCIAL_BODY_MAX: Readonly<Record<SocialPostKind, number>> = { text: 4_000, svg: 30_000, html: 60_000 };
export const SOCIAL_HANDLE_MAX = 40;
/** Posts older than this are pruned. */
export const SOCIAL_RETENTION_DAYS = 90;

/** A post as the user's feed shows it: unlike what agents read, it says which task and session it came from. */
export const SocialPost = z.object({
  id: z.number().int(),
  handle: z.string().nullable(),
  kind: SocialPostKind,
  body: z.string(),
  replyTo: z.number().int().nullable(),
  createdAt: z.string(),
  /** The task the post came from, while it still exists. */
  task: z.object({ id: z.string(), number: z.number().int(), title: z.string() }).nullable(),
  sessionId: z.string().nullable(),
});
export type SocialPost = z.infer<typeof SocialPost>;

export const SocialFeed = z.object({ posts: z.array(SocialPost) });
export type SocialFeed = z.infer<typeof SocialFeed>;
